// Lint rules for the browser code (web/) and the Cloudflare function (functions/).
import globals from "globals";

export default [
  {
    files: ["web/**/*.js"],
    ignores: ["web/vendor/**"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser, maplibregl: "readonly", pmtiles: "readonly" },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "error",
      "no-shadow": "warn",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["functions/**/*.js", "tests/js/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.worker, ...globals.node } },
    rules: { "no-undef": "error", "no-unused-vars": "error", "prefer-const": "error", eqeqeq: ["error", "smart"] },
  },
];
