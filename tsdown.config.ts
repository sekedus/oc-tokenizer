import { defineConfig } from "tsdown";

// Warning hygiene for `npm run build`:
// - `outputOptions.exports: "named"` — src/index.ts intentionally pairs a
//   default export with named exports; the CJS bundle already exposes both
//   (`exports.default` plus named keys), so declare named mode explicitly
//   instead of emitting MIXED_EXPORTS on every build.
// - `checks.pluginTimings: false` — per-plugin timing breakdowns are noise
//   here; build time is dominated by the multi-MB encoding tables.
// - `suppressWarnings` — rolldown-plugin-dts synthesizes a virtual
//   src/models.json.d.ts with `export =` when bundling the JSON import's
//   types; the emitted .d.ts inlines the full models typing correctly, so
//   the warning is benign.
const shared = {
  outputOptions: { exports: "named" as const },
  checks: { pluginTimings: false },
  suppressWarnings: ["uses CommonJS dts syntax"],
};

export default defineConfig([{
  entry: "./src/index.ts",
  outDir: "./dist",
  dts: true,
  format: ["esm", "cjs"],
  target: "es2020",
  sourcemap: true,
  fixedExtension: false,
  ...shared,
}, {
  entry: "./src/sdk.ts",
  outDir: "./dist",
  dts: true,
  format: ["esm", "cjs"],
  target: "es2020",
  sourcemap: true,
  fixedExtension: false,
  ...shared,
}, {
  entry: "./src/encoding/*",
  outDir: "./dist/encoding/",
  format: ["esm", "cjs"],
  target: "es2020",
  dts: true,
  sourcemap: false,
  minify: false,
  fixedExtension: false,
  ...shared,
}]);
