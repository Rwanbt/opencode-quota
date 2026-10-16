import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 100,
    sortPackageJson: false,
    ignorePatterns: [
      "pnpm-lock.yaml",
      "scripts/upstream-plugins/**",
      "src/data/modelsdev-pricing.min.json",
      "**/*.md",
    ],
  },
  lint: {
    ignorePatterns: ["dist/**", "scripts/upstream-plugins/**"],
    categories: { correctness: "error" },
    rules: {
      "array-callback-return": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-case-declarations": "error",
      "no-constructor-return": "error",
      "no-fallthrough": "error",
      "no-inner-declarations": "error",
      "no-label-var": "error",
      "no-redeclare": "error",
      "no-self-compare": "error",
      "oxc/misrefactored-assign-op": "error",
      "typescript/no-empty-interface": "error",
    },
    overrides: [{ files: ["src/lib/display-sanitize.ts"], rules: { "no-control-regex": "off" } }],
  },
});
