import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGh(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("gh", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    const e = err as {
      message?: string;
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const detail = [e.stderr, e.stdout, e.message]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n")
      .trim();
    throw new Error(detail || `gh ${args.join(" ")} failed`);
  }
}

/**
 * Ensure a GitHub PR exists for the current branch in `cwd`.
 * Reuses an existing PR for the branch when present.
 */
export async function ensurePullRequest(input: {
  cwd: string;
  title: string;
  body?: string;
  base?: string;
}): Promise<{ url: string; created: boolean }> {
  const base = input.base?.trim() || "main";

  try {
    const viewed = await runGh(input.cwd, [
      "pr",
      "view",
      "--json",
      "url",
      "-q",
      ".url",
    ]);
    const existing = viewed.stdout.trim();
    if (existing.startsWith("http")) {
      return { url: existing, created: false };
    }
  } catch {
    // No PR for current branch yet.
  }

  const args = [
    "pr",
    "create",
    "--base",
    base,
    "--title",
    input.title.trim() || "Update",
    "--body",
    input.body?.trim() || "## Summary\n\n- Task changes\n",
  ];
  const created = await runGh(input.cwd, args);
  const url = created.stdout.trim().split(/\s+/).find((t) => t.startsWith("http"));
  if (!url) {
    throw new Error(
      `gh pr create succeeded but no URL in output: ${created.stdout || created.stderr}`,
    );
  }
  return { url, created: true };
}
