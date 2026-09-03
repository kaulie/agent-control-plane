/**
 * Smoke tests for the generic decision observer pipeline.
 * Run: node --experimental-strip-types scripts/test-decisions.mjs
 *   or: npx tsx scripts/test-decisions.mjs
 */
import assert from "node:assert/strict";
import {
  collectDecisionEvents,
  networkGitRoutingObserver,
} from "../src/decisions/index.ts";
import {
  extractMcpToolName,
  tokenizeCommand,
} from "../src/decisions/observers/network-git-routing.ts";

function baseEvent(over = {}) {
  return {
    eventId: "evt-1",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    timestamp: new Date().toISOString(),
    eventType: "tool_call_started",
    payload: {},
    ...over,
  };
}

const ctxOn = {
  ambientProxyUrl: "http://127.0.0.1:7897",
  ambientShellProxy: true,
  mcpProxyAvailable: true,
};

const ctxOff = {
  ambientProxyUrl: "",
  ambientShellProxy: false,
  mcpProxyAvailable: false,
};

assert.equal(extractMcpToolName("mcp", { toolName: "git_with_proxy" }), "git_with_proxy");
assert.deepEqual(tokenizeCommand('git push -u origin HEAD'), ["git", "push", "-u", "origin", "HEAD"]);

{
  const events = collectDecisionEvents(
    ctxOn,
    baseEvent({
      payload: {
        callId: "c1",
        toolType: "mcp",
        args: { toolName: "git_with_proxy", providerIdentifier: "git-via-proxy" },
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "agent_decision");
  assert.equal(events[0].payload.choice, "mcp_proxied");
  assert.equal(events[0].payload.decisionId, "network.git.routing");
  assert.equal(events[0].payload.source, "observed");
}

{
  const events = collectDecisionEvents(
    ctxOn,
    baseEvent({
      eventType: "terminal",
      payload: {
        callId: "c2",
        toolType: "shell",
        args: { command: "git push -u origin HEAD" },
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.choice, "shell_ambient_proxy");
}

{
  const events = collectDecisionEvents(
    ctxOff,
    baseEvent({
      eventType: "terminal",
      payload: {
        callId: "c3",
        toolType: "shell",
        args: { command: "gh pr create --title t" },
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.choice, "shell_direct");
}

{
  const events = collectDecisionEvents(
    ctxOn,
    baseEvent({
      eventType: "terminal",
      payload: {
        callId: "c4",
        toolType: "shell",
        args: { command: "git status" },
      },
    }),
  );
  assert.equal(events.length, 0, "local git must not emit decisions");
}

{
  const seen = new Set();
  const ev = baseEvent({
    payload: {
      callId: "c5",
      toolType: "mcp",
      args: { toolName: "run_with_proxy" },
    },
  });
  const a = collectDecisionEvents(ctxOn, ev, { seenKeys: seen });
  const b = collectDecisionEvents(ctxOn, ev, { seenKeys: seen });
  assert.equal(a.length, 1);
  assert.equal(b.length, 0, "dedupe by callId");
}

{
  const payloads = networkGitRoutingObserver.observe(
    ctxOn,
    baseEvent({
      eventType: "agent_response",
      payload: { text: "hello" },
    }),
  );
  assert.equal(payloads, null);
}

console.log("test-decisions: ok");
