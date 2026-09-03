import type { AgentEvent } from "../../types.js";
import type {
  AgentDecisionPayload,
  DecisionContext,
  DecisionObserver,
} from "../types.js";

export const NETWORK_GIT_ROUTING_ID = "network.git.routing";

const NETWORK_GIT_SUBCOMMANDS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "submodule",
]);

const LOCAL_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "commit",
  "add",
  "branch",
  "checkout",
  "switch",
  "show",
  "stash",
  "rev-parse",
  "config",
]);

const MCP_PROXY_TOOLS = new Set(["git_with_proxy", "run_with_proxy"]);

const TOOL_EVENT_TYPES = new Set([
  "tool_call_started",
  "tool_result",
  "terminal",
  "file_read",
  "file_edit",
  "search",
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Resolve nested MCP tool name from Cursor/Cline-shaped args. */
export function extractMcpToolName(
  toolType: string,
  args: Record<string, unknown> | null,
): string | null {
  if (!args) return null;
  if (typeof args.toolName === "string" && args.toolName.trim()) {
    return args.toolName.trim();
  }
  if (typeof args.name === "string" && args.name.trim()) {
    return args.name.trim();
  }
  const nested = asRecord(args.args);
  if (nested && typeof nested.toolName === "string") {
    return nested.toolName.trim();
  }
  if (MCP_PROXY_TOOLS.has(toolType)) return toolType;
  return null;
}

function shellCommand(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  if (typeof args.command === "string") return args.command;
  return null;
}

/** Tokenize a simple shell command enough to detect git/gh verbs. */
export function tokenizeCommand(command: string): string[] {
  const cleaned = command.replace(/\\\n/g, " ").replace(/\n/g, " ").trim();
  if (!cleaned) return [];
  const tokens: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s;|&]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    tokens.push(m[0].replace(/^['"]|['"]$/g, ""));
  }
  return tokens;
}

function findGitSubcommand(tokens: string[]): string | null {
  const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
  if (gitIdx < 0) return null;
  for (let i = gitIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) continue;
    return t;
  }
  return null;
}

function isGhNetworkCommand(tokens: string[]): boolean {
  return tokens.some((t) => t === "gh" || t.endsWith("/gh"));
}

function isNetworkGitSubcommand(sub: string | null): boolean {
  if (!sub) return false;
  if (LOCAL_GIT_SUBCOMMANDS.has(sub)) return false;
  return NETWORK_GIT_SUBCOMMANDS.has(sub);
}

function decision(
  partial: Omit<AgentDecisionPayload, "source" | "decisionId"> & {
    decisionId?: string;
  },
): AgentDecisionPayload {
  return {
    decisionId: partial.decisionId ?? NETWORK_GIT_ROUTING_ID,
    choice: partial.choice,
    rationale: partial.rationale,
    source: "observed",
    subject: partial.subject,
    evidence: partial.evidence,
    alternatives: partial.alternatives,
  };
}

export const networkGitRoutingObserver: DecisionObserver = {
  id: "network-git-routing",
  observe(
    ctx: DecisionContext,
    event: AgentEvent,
  ): AgentDecisionPayload[] | null {
    if (!TOOL_EVENT_TYPES.has(event.eventType)) return null;

    const payload = event.payload;
    const toolType = String(payload.toolType ?? "");
    const args = asRecord(payload.args);
    const callId =
      typeof payload.callId === "string" ? payload.callId : undefined;

    const mcpTool = extractMcpToolName(toolType, args);
    if (mcpTool && MCP_PROXY_TOOLS.has(mcpTool)) {
      return [
        decision({
          choice: "mcp_proxied",
          rationale: `选用显式代理能力 ${mcpTool}（MCP）`,
          subject: {
            callId,
            toolType,
            summary: `mcp ${mcpTool}`,
          },
          evidence: {
            mcpTool,
            providerIdentifier:
              typeof args?.providerIdentifier === "string"
                ? args.providerIdentifier
                : undefined,
            ambientProxyUrl: ctx.ambientProxyUrl || null,
            mcpProxyAvailable: ctx.mcpProxyAvailable,
          },
          alternatives: [
            ctx.ambientShellProxy && ctx.ambientProxyUrl
              ? "shell_ambient_proxy"
              : "shell_direct",
          ],
        }),
      ];
    }

    // Prefer tool_call_started / terminal for Shell; skip non-shell tool_result noise.
    if (
      event.eventType === "tool_result" &&
      toolType !== "shell" &&
      toolType !== "terminal"
    ) {
      return null;
    }

    const command = shellCommand(args);
    if (!command) return null;

    const tokens = tokenizeCommand(command);
    const gitSub = findGitSubcommand(tokens);
    const gh = isGhNetworkCommand(tokens);

    if (gitSub && LOCAL_GIT_SUBCOMMANDS.has(gitSub) && !gh) {
      return null;
    }

    const network = isNetworkGitSubcommand(gitSub) || gh;
    if (!network) return null;

    const ambientOn = Boolean(ctx.ambientProxyUrl) && ctx.ambientShellProxy;
    const choice = ambientOn ? "shell_ambient_proxy" : "shell_direct";
    const label = gh ? "gh" : `git ${gitSub}`;
    const rationale = ambientOn
      ? `Shell 网络 ${label}：进程继承 ambient HTTP_PROXY`
      : `Shell 网络 ${label}：未启用 ambient 代理（直连）`;

    return [
      decision({
        choice,
        rationale,
        subject: {
          callId,
          toolType: toolType || "shell",
          summary: command.slice(0, 160),
        },
        evidence: {
          command: command.slice(0, 240),
          gitSubcommand: gitSub,
          gh,
          ambientProxyUrl: ctx.ambientProxyUrl || null,
          ambientShellProxy: ctx.ambientShellProxy,
          mcpProxyAvailable: ctx.mcpProxyAvailable,
        },
        alternatives: ctx.mcpProxyAvailable ? ["mcp_proxied"] : undefined,
      }),
    ];
  },
};
