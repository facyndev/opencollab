import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function getAllSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith("boundary.spec.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("@opencollab/ui boundary constraints", () => {
  const srcFiles = getAllSourceFiles(__dirname);

  it("never imports @tauri-apps/api inside @opencollab/ui", () => {
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      expect(content, `File ${file} must not import @tauri-apps/api`).not.toContain("@tauri-apps/api");
    }
  });

  it("never imports @xterm inside @opencollab/ui", () => {
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      expect(content, `File ${file} must not import @xterm`).not.toContain("@xterm");
    }
  });
});
