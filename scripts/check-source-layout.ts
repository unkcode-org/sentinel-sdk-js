import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const generatedDirectories = new Set([
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "test/browser/.generated",
]);

async function visit(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const violations: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const local = relative(root, absolute);
    if (entry.isDirectory()) {
      if (!generatedDirectories.has(local) && entry.name !== ".git") {
        violations.push(...(await visit(absolute)));
      }
      continue;
    }
    if ([".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
      violations.push(local);
    }
  }
  return violations;
}

const violations = await visit(root);
if (violations.length > 0) {
  throw new Error(
    `Handwritten JavaScript is not allowed outside generated output:\n${violations.join("\n")}`,
  );
}
console.log("Source layout valid: handwritten production and tooling use TypeScript.");
