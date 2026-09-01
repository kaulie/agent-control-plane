import fs from "node:fs";
import path from "node:path";

const MAX_CWD_RULES_CHARS = 12000;

/**
 * Read AGENTS.md / AGENT.md and .cursor/rules/*.mdc from a workspace for display.
 */
export function readCwdRules(cwd: string): string | undefined {
  if (!cwd?.trim() || !fs.existsSync(cwd)) return undefined;

  const parts: string[] = [];

  for (const name of ["AGENTS.md", "AGENT.md"]) {
    const filePath = path.join(cwd, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const text = fs.readFileSync(filePath, "utf8").trim();
      if (text) parts.push(`## ${name}\n\n${text}`);
    } catch {
      /* ignore */
    }
  }

  const rulesDir = path.join(cwd, ".cursor", "rules");
  if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
    const files = fs
      .readdirSync(rulesDir)
      .filter((f) => f.endsWith(".mdc") || f.endsWith(".md"))
      .sort();
    for (const file of files) {
      try {
        const text = fs.readFileSync(path.join(rulesDir, file), "utf8").trim();
        if (text) parts.push(`## .cursor/rules/${file}\n\n${text}`);
      } catch {
        /* ignore */
      }
    }
  }

  if (!parts.length) return undefined;
  let combined = parts.join("\n\n---\n\n");
  if (combined.length > MAX_CWD_RULES_CHARS) {
    combined = `${combined.slice(0, MAX_CWD_RULES_CHARS - 1)}…`;
  }
  return combined;
}
