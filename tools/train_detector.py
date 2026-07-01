#!/usr/bin/env python3
"""Train the IRIS localizer and export it to ONNX — torch-free (numpy + autograd + onnx).

The detector has to hand the decoder a precisely-framed disc, which means predicting the
disc's center, size AND eccentricity accurately. An earlier version REGRESSED the ellipse
(a, b, phi) through a global-pool FC head — and a regression head provably collapses toward
the dataset mean: it over-sized small codes ~1.2x and under-sized large ones ~0.95x, so the
decode crop was framed wrong and decoding failed. The fix is a different FORMULATION:

  • pupil-center  → a soft-argmax keypoint (the bullseye is a distinctive point) → ray origin
  • disc extent   → SEMANTIC SEGMENTATION: a per-pixel "is this the disc" mask. A conv net
                    learns the disc by its radial-ring structure (vs a colourful background),
                    and a mask captures exact size + eccentricity with NO regress-to-mean.
                    The disc ellipse is recovered from the mask by weighted moments
                    (≈1% median major-axis error vs ~25% for the FC head).

Rotation is still recovered by the deterministic polar scan in web/ray-refine.js.

Output head (2 + HF*HF): [cx/W, cy/W, disc_mask(HF x HF, row-major, sigmoid)].

    python tools/train_detector.py --data data/iris --out web/models/iris-detector.onnx
"""
import argparse, json, os, math
import numpy as np
import autograd.numpy as anp
from autograd import grad

S = 96          # model input side (px); dataset --size must be a multiple of S.
HF = 24         # backbone output side, and the disc-mask resolution (96 -> /2 -> /2)
CH = (8, 16, 32)

def read_ppm(path):
    with open(path, "rb") as f:
        buf = f.read()
    assert buf[:2] == b"P6", path
    pos, toks = 2, []
    while len(toks) < 3:
        while buf[pos] in b" \t\n\r":
            pos += 1
        if buf[pos:pos+1] == b"#":
            while buf[pos] != 0x0A:
                pos += 1
            continue
        s = pos
        while buf[pos] not in b" \t\n\r":
            pos += 1
        toks.append(buf[s:pos])
    w, h = int(toks[0]), int(toks[1])
    pos += 1
    return np.frombuffer(buf, np.uint8, count=w*h*3, offset=pos).reshape(h, w, 3)

def downsample(img, W):
    blk = W // S
    x = img.reshape(S, blk, S, blk, 3).mean(axis=(1, 3)) / 255.0
    return np.transpose(x, (2, 0, 1)).astype(np.float32)

def disc_mask(e, W):
    """Rasterize the disc ellipse to an HF x HF binary mask (cell centers in image px)."""
    cell = W / HF
    cx, cy, a, b, phi = e["cx"], e["cy"], e["a"], e["b"], math.radians(e["phi_deg"])
    c, s = math.cos(phi), math.sin(phi)
    grid = (np.arange(HF) + 0.5) * cell
    X, Y = np.meshgrid(grid, grid)
    dx, dy = X - cx, Y - cy
    u = (dx*c + dy*s) / a
    v = (-dx*s + dy*c) / b
    return (u*u + v*v <= 1).astype(np.float32).reshape(HF*HF)

def load(data_dir):
    labels = [json.loads(l) for l in open(os.path.join(data_dir, "labels.jsonl")) if l.strip()]
    W = labels[0]["width"]
    X, C, M = [], [], []
    for lab in labels:
        X.append(downsample(read_ppm(os.path.join(data_dir, lab["file"])), W))
        C.append([lab["center"][0]/W, lab["center"][1]/W])
        M.append(disc_mask(lab["ellipse"], W))
    return np.array(X, np.float32), np.array(C, np.float32), np.array(M, np.float32), W

# ── CNN (autograd) ───────────────────────────────────────────────────────────

def conv(x, Wk, b, pad=1):
    N, C, H, Wd = x.shape
    O, _, kh, kw = Wk.shape
    zh = anp.zeros((N, C, pad, Wd), dtype=x.dtype)
    xp = anp.concatenate([zh, x, zh], axis=2)
    zw = anp.zeros((N, C, H + 2*pad, pad), dtype=x.dtype)
    xp = anp.concatenate([zw, xp, zw], axis=3)
    cols = [xp[:, :, i:i+H, j:j+Wd] for i in range(kh) for j in range(kw)]
    col = anp.concatenate(cols, axis=1)
    Wm = anp.reshape(anp.transpose(Wk, (0, 2, 3, 1)), (O, kh*kw*C))
    return anp.transpose(anp.tensordot(col, Wm, axes=([1], [1])), (0, 3, 1, 2)) + anp.reshape(b, (1, O, 1, 1))

def pool2(x):
    N, C, H, Wd = x.shape
    x = anp.reshape(x, (N, C, H//2, 2, Wd//2, 2))
    return anp.max(anp.max(x, axis=5), axis=3)

GX = np.tile(np.linspace(0, 1, HF), HF).astype(np.float32)
GY = np.repeat(np.linspace(0, 1, HF), HF).astype(np.float32)

def backbone(P, x):
    a = anp.maximum(conv(x, P["W1"], P["b1"]), 0)
    a = pool2(anp.maximum(conv(a, P["W2"], P["b2"]), 0))
    a = pool2(anp.maximum(conv(a, P["W3"], P["b3"]), 0))
    return a  # (N, 32, HF, HF)

def forward(P, x):
    a = backbone(P, x)
    N = a.shape[0]
    hm = anp.reshape(anp.tensordot(a, P["Wc"], axes=([1], [0])), (N, HF*HF))   # center heatmap
    hm = hm - anp.max(hm, axis=1, keepdims=True)
    e = anp.exp(hm); sm = e / anp.sum(e, axis=1, keepdims=True)
    cx = anp.sum(sm*GX, axis=1); cy = anp.sum(sm*GY, axis=1)
    mask = anp.reshape(anp.tensordot(a, P["Wm"], axes=([1], [0])), (N, HF*HF)) + P["bm"][0]  # logits
    return anp.concatenate([cx[:, None], cy[:, None], mask], axis=1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/iris")
    ap.add_argument("--out", default="web/models/iris-detector.onnx")
    ap.add_argument("--epochs", type=int, default=45)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--batch", type=int, default=64)
    args = ap.parse_args()

    X, C, M, W = load(args.data)
    rng = np.random.default_rng(0)
    perm = rng.permutation(len(X))
    X, C, M = X[perm], C[perm], M[perm]
    nv = max(1, len(X)//10)
    Xtr, Ctr, Mtr, Xva, Cva, Mva = X[nv:], C[nv:], M[nv:], X[:nv], C[:nv], M[:nv]
    mean, std = float(Xtr.mean()), float(Xtr.std() + 1e-6)
    Xtr = (Xtr - mean)/std; Xva = (Xva - mean)/std
    print(f"loaded {len(X)} ({len(Xtr)} tr/{nv} val) W={W} input 3x{S}x{S}, mask {HF}x{HF}")

    def he(s, f): return (rng.standard_normal(s)*math.sqrt(2/f)).astype(np.float32)
    P = {
        "W1": he((CH[0], 3, 3, 3), 27), "b1": np.zeros(CH[0], np.float32),
        "W2": he((CH[1], CH[0], 3, 3), CH[0]*9), "b2": np.zeros(CH[1], np.float32),
        "W3": he((CH[2], CH[1], 3, 3), CH[1]*9), "b3": np.zeros(CH[2], np.float32),
        "Wc": he((CH[2],), CH[2]),                                   # center heatmap
        "Wm": he((CH[2],), CH[2]), "bm": np.zeros(1, np.float32),    # disc mask
    }

    def loss(P, xb, cb, mb):
        out = forward(P, xb)
        cl = anp.mean((out[:, :2] - cb)**2)
        lg = out[:, 2:]
        bce = anp.mean(anp.maximum(lg, 0) - lg*mb + anp.log(1 + anp.exp(-anp.abs(lg))))
        return 5.0*cl + bce
    gl = grad(loss)
    m = {k: np.zeros_like(v) for k, v in P.items()}
    v = {k: np.zeros_like(val) for k, val in P.items()}
    b1a, b2a, eps, t = 0.9, 0.999, 1e-8, 0
    JG, IG = np.meshgrid(np.arange(HF), np.arange(HF))
    def fit_major(pm):
        w = pm.reshape(HF, HF); tot = w.sum() + 1e-6; cell = W/HF
        cx = (w*JG).sum()/tot; cy = (w*IG).sum()/tot
        cxx = (w*(JG-cx)**2).sum()/tot; cyy = (w*(IG-cy)**2).sum()/tot; cxy = (w*(JG-cx)*(IG-cy)).sum()/tot
        tr = cxx+cyy; d = math.sqrt(max(0, (cxx-cyy)**2/4 + cxy*cxy))
        return 2*math.sqrt(max(tr/2+d, 1e-6))*cell
    for ep in range(args.epochs):
        o = rng.permutation(len(Xtr))
        for i in range(0, len(Xtr), args.batch):
            idx = o[i:i+args.batch]
            g = gl(P, Xtr[idx], Ctr[idx], Mtr[idx]); t += 1
            for k in P:
                m[k] = b1a*m[k] + (1-b1a)*g[k]
                v[k] = b2a*v[k] + (1-b2a)*(g[k]*g[k])
                P[k] -= args.lr*(m[k]/(1-b1a**t))/(np.sqrt(v[k]/(1-b2a**t))+eps)
        ov = np.asarray(forward(P, Xva))
        ce = np.hypot(ov[:, 0]-Cva[:, 0], ov[:, 1]-Cva[:, 1]).mean()*W
        pm = 1/(1+np.exp(-ov[:, 2:]))
        merr = []
        for i in range(len(Xva)):
            pa = fit_major(pm[i]); ta = fit_major(Mva[i]); merr.append(abs(pa-ta)/max(ta, 1))
        print(f"  epoch {ep:2d}  pupil {ce:5.1f}px  disc major-axis err {np.median(merr)*100:4.1f}% (median)")
    export_onnx(P, mean, std, args.out)
    print(f"wrote {args.out}")

def export_onnx(P, mean, std, out_path):
    import onnx
    from onnx import helper, TensorProto, numpy_helper
    W1 = (P["W1"]/std).astype(np.float32)
    b1 = (P["b1"] - (mean/std)*P["W1"].sum(axis=(1, 2, 3))).astype(np.float32)
    gxcol = GX.reshape(HF*HF, 1).astype(np.float32)
    gycol = GY.reshape(HF*HF, 1).astype(np.float32)
    arr = {"W1": W1, "b1": b1, "W2": P["W2"], "b2": P["b2"], "W3": P["W3"], "b3": P["b3"],
           "Wc": P["Wc"].reshape(1, CH[2], 1, 1), "bc": np.zeros(1, np.float32),
           "Wm": P["Wm"].reshape(1, CH[2], 1, 1), "bm": P["bm"].astype(np.float32),
           "GX": gxcol, "GY": gycol, "shp": np.array([1, HF*HF], np.int64)}
    inits = [numpy_helper.from_array(v.astype(v.dtype), k) for k, v in arr.items()]
    n = []
    def cv(i, w, b, o, pool):
        n.append(helper.make_node("Conv", [i, w, b], [o+"c"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]))
        n.append(helper.make_node("Relu", [o+"c"], [o+"r"]))
        if pool:
            n.append(helper.make_node("MaxPool", [o+"r"], [o], kernel_shape=[2, 2], strides=[2, 2]))
        return o if pool else o+"r"
    f1 = cv("input", "W1", "b1", "a1", False)
    f2 = cv(f1, "W2", "b2", "a2", True)
    feat = cv(f2, "W3", "b3", "a3", True)
    # center keypoint: 1x1 conv -> softmax -> coord MatMul
    n.append(helper.make_node("Conv", [feat, "Wc", "bc"], ["ch"], kernel_shape=[1, 1]))
    n.append(helper.make_node("Reshape", ["ch", "shp"], ["cf"]))
    n.append(helper.make_node("Softmax", ["cf"], ["cs"], axis=1))
    n.append(helper.make_node("MatMul", ["cs", "GX"], ["cx"]))
    n.append(helper.make_node("MatMul", ["cs", "GY"], ["cy"]))
    # disc mask: 1x1 conv -> sigmoid
    n.append(helper.make_node("Conv", [feat, "Wm", "bm"], ["mh"], kernel_shape=[1, 1]))
    n.append(helper.make_node("Reshape", ["mh", "shp"], ["mf"]))
    n.append(helper.make_node("Sigmoid", ["mf"], ["mask"]))
    n.append(helper.make_node("Concat", ["cx", "cy", "mask"], ["output"], axis=1))
    inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, S, S])
    out = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 2 + HF*HF])
    graph = helper.make_graph(n, "iris-detector", [inp], [out], inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    onnx.save(model, out_path)

if __name__ == "__main__":
    main()
