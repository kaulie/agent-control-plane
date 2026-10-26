/**
 * A task with no model must still start a local Cursor agent.
 * Catalog lookup is a cloud call and needs the task account key — not
 * CURSOR_API_KEY. Without it, send() dies with
 * "Local SDK agents require an explicit model".
 *
 * Usage: npx tsx backend/scripts/test-cursor-model.mjs
 */
import { Agent, Cursor } from "@cursor/sdk";
import { CursorProvider } from "../src/providers/cursor/index.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const originalList = Cursor.models.list;
const originalCreate = Agent.create;
const originalResume = Agent.resume;

/** @type {Array<{ apiKey?: string } | undefined>} */
const listCalls = [];
/** @type {Array<Record<string, unknown>>} */
const createCalls = [];
/** @type {Array<{ id: string, model?: { id?: string } }>} */
const resumeCalls = [];
/** @type {Array<Record<string, unknown> | undefined>} */
const sendCalls = [];

function makeAgent(agentId, model) {
  return {
    agentId,
    model,
    close() {},
    getUsage: async () => ({}),
    send: async (_message, opts) => {
      sendCalls.push(opts);
      return {
        async *stream() {},
        wait: async () => ({ status: "finished", result: "ok" }),
      };
    },
  };
}

Cursor.models.list = async (opts) => {
  listCalls.push(opts);
  if (!opts?.apiKey) {
    throw new Error(
      "API key is required for cloud operations. Set CURSOR_API_KEY, pass apiKey, or run Cursor.auth.login().",
    );
  }
  if (opts.apiKey === "account-key") {
    return [
      { id: "default", displayName: "Auto" },
      { id: "grok-4.7", displayName: "Grok 4.7" },
    ];
  }
  return [];
};

Agent.create = async (options) => {
  createCalls.push(options);
  return makeAgent("agent-created", options?.model);
};

Agent.resume = async (id, options) => {
  resumeCalls.push({ id, model: options?.model });
  // Resume does not adopt options.model; the stored agent has none.
  return makeAgent(id, undefined);
};

function input(overrides) {
  return {
    taskId: "task-model",
    runId: "run-model",
    agentId: "",
    cwd: process.cwd(),
    mode: "agent",
    prompt: { text: "hi" },
    onEvent: () => {},
    ...overrides,
  };
}

try {
  const unnamed = new CursorProvider({});
  const events = [];
  const created = await unnamed.run(
    input({
      taskId: "task-unnamed",
      runId: "run-unnamed",
      apiKey: "account-key",
      onEvent: (event) => events.push(event),
    }),
  );
  assert(created.status === "finished", `unnamed model run failed: ${created.error}`);
  assert(listCalls.length === 1, `expected one catalog call, got ${listCalls.length}`);
  assert(listCalls[0]?.apiKey === "account-key", "catalog call must use the task account key");
  assert(createCalls.length === 1, "expected a new agent");
  assert(createCalls[0]?.model?.id === "default", `create model was ${createCalls[0]?.model?.id}`);
  const started = events.find((event) => event.eventType === "run_started");
  assert(started?.payload?.model === "default", "run_started should record the resolved model");
  assert(
    !sendCalls.some((opts) => opts?.model),
    "a freshly created agent already has a model; send should not override it",
  );

  sendCalls.length = 0;
  const listsAfterCreate = listCalls.length;
  const resumed = await unnamed.run(
    input({
      taskId: "task-resume",
      runId: "run-resume",
      agentId: "agent-created-without-model",
      apiKey: "account-key",
    }),
  );
  assert(resumed.status === "finished", `resume without stored model failed: ${resumed.error}`);
  assert(listCalls.length === listsAfterCreate, "catalog lookup is cached per account key");
  assert(resumeCalls.length === 1, "expected resume of the model-less agent");
  assert(createCalls.length === 1, "resume must not create a second agent");
  assert(
    sendCalls[0]?.model?.id === "default",
    `send must supply the model the resumed agent does not have, got ${JSON.stringify(sendCalls[0])}`,
  );

  const beforeList = listCalls.length;
  const beforeCreate = createCalls.length;
  const explicit = await unnamed.run(
    input({
      taskId: "task-explicit",
      runId: "run-explicit",
      model: "grok-4.7",
      apiKey: "account-key",
    }),
  );
  assert(explicit.status === "finished", `explicit model run failed: ${explicit.error}`);
  assert(listCalls.length === beforeList, "an explicit model must not list the catalog");
  assert(createCalls.at(-1)?.model?.id === "grok-4.7", "explicit model is passed to create");
  assert(createCalls.length === beforeCreate + 1, "explicit model still creates an agent");

  const missingEvents = [];
  const missing = await new CursorProvider({}).run(
    input({
      taskId: "task-missing",
      runId: "run-missing",
      apiKey: "unknown-key",
      onEvent: (event) => missingEvents.push(event),
    }),
  );
  assert(missing.status === "error", "missing catalog must fail the run");
  assert(
    /需要明确的模型/.test(missing.error ?? ""),
    `unexpected missing-model error: ${missing.error}`,
  );
  assert(
    missingEvents.some((event) => event.eventType === "run_error"),
    "missing model should be visible on the timeline",
  );
  assert(createCalls.length === beforeCreate + 1, "must not create an agent when no model can be resolved");

  console.log("cursor model resolution ok");
} finally {
  Cursor.models.list = originalList;
  Agent.create = originalCreate;
  Agent.resume = originalResume;
}
