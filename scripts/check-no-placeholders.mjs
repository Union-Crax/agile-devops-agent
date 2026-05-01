import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const includeExt = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".md", ".json"]);
const ignoreDirs = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "coverage",
]);

const placeholderPatterns = [
  /remaining\s+program\s+code\s+unchanged/i,
  /program\s+code\s+unchanged/i,
  /rest\s+of\s+(the\s+)?(file|code)\s+unchanged/i,
  /placeholder\s+patch/i,
  /todo\s*:\s*rest\s+unchanged/i,
  /\.\.\.\s*remaining\s+code/i,
];

async function walk(dir, files = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name)) {
        await walk(fullPath, files);
      }
      continue;
    }

    if (includeExt.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const files = await walk(root);
  const hits = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of placeholderPatterns) {
        if (pattern.test(line)) {
          hits.push({
            file: path.relative(root, filePath).replaceAll("\\", "/"),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
  }

  if (hits.length > 0) {
    console.error("Placeholder guard failed. Remove partial patch markers:");
    for (const hit of hits) {
      console.error(`- ${hit.file}:${hit.line} -> ${hit.text}`);
    }
    process.exit(1);
  }

  console.log("Placeholder guard passed.");
}

main().catch((error) => {
  console.error("Placeholder guard crashed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});