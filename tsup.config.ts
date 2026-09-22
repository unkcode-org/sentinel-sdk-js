import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
    "web-vitals/index": "src/web-vitals/index.ts",
  },
  format: ["esm"],
  target: "es2020",
  platform: "browser",
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react/jsx-runtime"],
});
