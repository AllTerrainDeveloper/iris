// Reed–Solomon over GF(256), primitive polynomial 0x11d (AGENTS.md §2.6).
// Self-contained, no dependencies. Ported from the canonical "Reed-Solomon
// codes for coders" algorithm. Polynomials are arrays with index 0 = highest
// degree coefficient.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]);
const inv = (a) => EXP[255 - LOG[a]];
const pow = (a, p) => EXP[(((LOG[a] * p) % 255) + 255) % 255];

function polyScale(p, x) {
  const r = new Array(p.length);
  for (let i = 0; i < p.length; i++) r[i] = mul(p[i], x);
  return r;
}

function polyAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function polyDiv(dividend, divisor) {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < divisor.length; j++) {
        if (divisor[j] !== 0) out[i + j] ^= mul(divisor[j], coef);
      }
    }
  }
  const sep = out.length - (divisor.length - 1);
  return [out.slice(0, sep), out.slice(sep)];
}

function genPoly(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
  return g;
}

/** Encode `msg` bytes into a codeword of length msg.length + nsym (AGENTS.md §2.6). */
export function rsEncode(msg, nsym) {
  const gen = genPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
  }
  out.set(msg); // restore data part (loop above only needs parity tail)
  return out;
}

function calcSyndromes(msg, nsym) {
  const synd = [0];
  for (let i = 0; i < nsym; i++) synd.push(polyEval(msg, pow(2, i)));
  return synd;
}

function findErrorLocator(synd, nsym, eraseCount = 0) {
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = synd.length - nsym;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 - eraseCount > nsym) return null; // too many to correct
  return errLoc;
}

// Forney syndromes: remove the influence of known erasures so the error locator
// only solves for the unknown error positions.
function forneySyndromes(synd, erasePos, nmess) {
  const fsynd = synd.slice(1); // drop leading 0
  for (let i = 0; i < erasePos.length; i++) {
    const x = pow(2, nmess - 1 - erasePos[i]);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = mul(fsynd[j], x) ^ fsynd[j + 1];
  }
  return fsynd;
}

function findErrors(errLoc, nmess) {
  const errs = errLoc.length - 1;
  const errPos = [];
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLoc, pow(2, i)) === 0) errPos.push(nmess - 1 - i);
  }
  if (errPos.length !== errs) return null;
  return errPos;
}

function findErrataLocator(coefPos) {
  let eLoc = [1];
  for (const i of coefPos) eLoc = polyMul(eLoc, polyAdd([1], [pow(2, i), 0]));
  return eLoc;
}

function findErrorEvaluator(synd, errLoc, nsym) {
  const [, rem] = polyDiv(polyMul(synd, errLoc), [1, ...new Array(nsym + 1).fill(0)]);
  return rem;
}

function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = findErrataLocator(coefPos);
  const errEval = findErrorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();

  const X = coefPos.map((cp) => pow(2, -(255 - cp)));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = inv(Xi);
    let denom = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) denom = mul(denom, 1 ^ mul(XiInv, X[j]));
    }
    let y = polyEval(errEval.slice().reverse(), XiInv);
    y = mul(pow(Xi, 1), y);
    E[errPos[i]] = div(y, denom);
  }
  const corrected = polyAdd(msg, E);
  // polyAdd may left-pad; keep exactly msg.length bytes
  return corrected.slice(corrected.length - msg.length);
}

/**
 * Correct a received codeword (AGENTS.md §3 step 7). `erasePos` lists known-bad
 * byte positions (e.g. cells hidden by a scratch); erasures cost half as much
 * parity as unknown errors, so flagging damage doubles the recovery capacity.
 * Returns the corrected codeword (Uint8Array) or null if uncorrectable.
 */
export function rsCorrect(code, nsym, erasePos = []) {
  let msg = Array.from(code);
  for (const e of erasePos) if (e >= 0 && e < msg.length) msg[e] = 0;
  if (erasePos.length > nsym) return null;

  const synd = calcSyndromes(msg, nsym);
  if (Math.max(...synd) === 0) return Uint8Array.from(msg); // clean

  let errataPos = erasePos.slice();
  if (erasePos.length < nsym) {
    const fsynd = forneySyndromes(synd, erasePos, msg.length);
    const errLoc = findErrorLocator(fsynd, nsym, erasePos.length);
    if (!errLoc) return null;
    const errPos = findErrors(errLoc.slice().reverse(), msg.length);
    if (!errPos) return null;
    if (2 * errPos.length + erasePos.length > nsym) return null;
    errataPos = erasePos.concat(errPos);
  }

  msg = correctErrata(msg, synd, errataPos);
  const check = calcSyndromes(msg, nsym);
  if (Math.max(...check) !== 0) return null;
  return Uint8Array.from(msg);
}
