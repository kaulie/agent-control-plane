#!/usr/bin/env node
/**
 * git-via-proxy — Cursor MCP server
 * Runs git / allowlisted network commands with a local HTTP proxy env.
 */
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PROXY_URL =
  process.env.GIT_VIA_PROXY_URL?.trim() || "http://127.0.0.1:7897";

const ALLOWED_BINS = new Set(["gh", "curl", "wget", "ssh", "scp", "rsync"]);

function proxyEnv() {
  return {
    ...process.env,
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    ALL_PROXY: PROXY_URL,
    all_proxy: PROXY_URL,
    // Avoid proxying localhost noise
    no_proxy: process.env.no_proxy || "localhost,127.0.0.1,::1",
    NO_PROXY: process.env.NO_PROXY || "localhost,127.0.0.1,::1",
  };
}

function runCommand(bin, args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: proxyEnv(),
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal: signal || null,
        stdout,
        stderr,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
      finish(124, "TIMEOUT");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err.message || err);
      finish(127, null);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish(code, signal);
    });
  });
}

function formatResult(bin, args, result) {
  const header = [
    `meta: via=proxy url=${PROXY_URL}`,
    `proxy: ${PROXY_URL}`,
    `cmd: ${bin} ${args.map((a) => JSON.stringify(a)).join(" ")}`,
    `exit: ${result.code}${result.signal ? ` signal=${result.signal}` : ""}`,
  ].join("\n");
  const body = [
    header,
    "",
    "--- stdout ---",
    result.stdout || "(empty)",
    "",
    "--- stderr ---",
    result.stderr || "(empty)",
  ].join("\n");
  return {
    content: [{ type: "text", text: body }],
    isError: result.code !== 0,
  };
}

const server = new McpServer({
  name: "git-via-proxy",
  version: "1.0.0",
});

server.tool(
  "proxy_env",
  "Show the HTTP proxy URL this MCP injects for network commands.",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            GIT_VIA_PROXY_URL: PROXY_URL,
            injected: [
              "http_proxy",
              "https_proxy",
              "HTTP_PROXY",
              "HTTPS_PROXY",
              "ALL_PROXY",
              "all_proxy",
            ],
          },
          null,
          2
        ),
      },
    ],
  })
);

server.tool(
  "git_with_proxy",
  "Run git with local HTTP proxy env. Prefer for fetch/pull/push/clone/ls-remote. Local-only ops (status/diff/log/commit) can use normal shell.",
  {
    args: z
      .array(z.string())
      .describe('Git arguments, e.g. ["fetch", "origin"] or ["push", "-u", "origin", "HEAD"]'),
    cwd: z
      .string()
      .optional()
      .describe("Working directory (absolute path). Defaults to process cwd."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in ms (default 120000)"),
  },
  async ({ args, cwd, timeout_ms }) => {
    if (!args || args.length === 0) {
      return {
        content: [{ type: "text", text: "error: args must be a non-empty array" }],
        isError: true,
      };
    }
    const result = await runCommand("git", args, {
      cwd,
      timeoutMs: timeout_ms,
    });
    return formatResult("git", args, result);
  }
);

server.tool(
  "run_with_proxy",
  "Run an allowlisted network binary (gh|curl|wget|ssh|scp|rsync) with proxy env.",
  {
    bin: z.enum(["gh", "curl", "wget", "ssh", "scp", "rsync"]),
    args: z.array(z.string()).describe("Command arguments"),
    cwd: z.string().optional().describe("Working directory (absolute path)"),
    timeout_ms: z.number().int().positive().optional(),
  },
  async ({ bin, args, cwd, timeout_ms }) => {
    if (!ALLOWED_BINS.has(bin)) {
      return {
        content: [{ type: "text", text: `error: bin not allowlisted: ${bin}` }],
        isError: true,
      };
    }
    const result = await runCommand(bin, args || [], {
      cwd,
      timeoutMs: timeout_ms,
    });
    return formatResult(bin, args || [], result);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
