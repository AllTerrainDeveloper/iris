// ESLint flat config. IRIS ships with zero *runtime* dependencies; ESLint is a
// dev-only tool. Run `npm run lint` (or `npm run lint:fix`).
import js from "@eslint/js";
import globals from "globals";

const quality = {
  "prefer-const": "error",
  "no-var": "error",
  eqeqeq: ["error", "smart"],
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-console": "off",
};

export default [
  { ignores: ["node_modules/**", "web/vendor/**"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: quality,
  },
  // Core library + CLI + tests run under Node. The src/ modules are also imported
  // by the browser, so allow both global sets there.
  {
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser, PIXI: "readonly" } },
  },
  {
    files: ["bin/**/*.js", "test/**/*.js", "tools/**/*.js", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  // The web generator runs in the browser (Tailwind and PixiJS loaded via CDN).
  {
    files: ["web/**/*.js"],
    languageOptions: { globals: { ...globals.browser, tailwind: "readonly", PIXI: "readonly", ort: "readonly" } },
  },
];
