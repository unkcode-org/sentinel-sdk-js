import { gzipSync } from "node:zlib";

import { build } from "esbuild";

interface Budget {
  readonly entry: string;
  readonly rawBytes?: number;
  readonly gzipBytes: number;
}

const budgets: Record<string, Budget> = {
  core: {
    entry: "src/index.ts",
    rawBytes: 200_000,
    gzipBytes: 65_000,
  },
  react: {
    entry: "src/react/index.ts",
    gzipBytes: 3_000,
  },
  "web-vitals": {
    entry: "src/web-vitals/index.ts",
    gzipBytes: 5_000,
  },
};

const results: Record<string, { rawBytes: number; gzipBytes: number }> = {};

for (const [name, budget] of Object.entries(budgets)) {
  const result = await build({
    entryPoints: [budget.entry],
    bundle: true,
    minify: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2020",
    external: ["react", "react/jsx-runtime"],
  });
  const rawBytes = result.outputFiles.reduce(
    (total, file) => total + file.contents.byteLength,
    0,
  );
  const gzipBytes = result.outputFiles.reduce(
    (total, file) => total + gzipSync(file.contents, { level: 9 }).byteLength,
    0,
  );
  results[name] = { rawBytes, gzipBytes };

  if (budget.rawBytes !== undefined && rawBytes > budget.rawBytes) {
    throw new Error(`${name} is ${rawBytes} bytes; budget is ${budget.rawBytes}`);
  }
  if (gzipBytes > budget.gzipBytes) {
    throw new Error(
      `${name} gzip is ${gzipBytes} bytes; budget is ${budget.gzipBytes}`,
    );
  }
}

console.table(results);
