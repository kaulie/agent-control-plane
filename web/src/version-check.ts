import { APP_VERSION } from "./version";

const DISMISS_KEY_PREFIX = "web-cursor:dismiss-update:";
const RELOAD_ATTEMPT_KEY = "web-cursor:reload-attempt";
/** After a reload for version V, suppress re-prompting V for this long. */
const RELOAD_SUPPRESS_MS = 60_000;
/** Seconds between two /health polls while the "upgrading" overlay is up. */
export const UPGRADE_POLL_SECONDS = 5;
/** How often the update button polls /health before hard-reloading. */
export const UPGRADE_POLL_MS = UPGRADE_POLL_SECONDS * 1_000;
/** Stop auto-refreshing after this long and let the user reload by hand. */
const UPGRADE_MAX_WAIT_MS = 10 * 60_000;

/**
 * Request header every frontend request carries so the gateway can verify the
 * page is running the version the project actually serves. Must stay in sync
 * with `backend/src/http/ui-version.ts`.
 */
export const UI_VERSION_HEADER = "x-ui-version";

/** Gateway error code for "your page is stale — refresh first". */
export const UI_VERSION_MISMATCH_CODE = "ui-version-mismatch";

export type VersionUpdate = {
  clientVersion: string;
  serverVersion: string;
};

/** Live state of the "正在升级中，请等待" overlay. */
export type UpgradeState = {
  /** Server version we are waiting for. */
  target: string;
  startedAt: number;
  /** /health polls already made. */
  attempts: number;
  /** Milliseconds since the wait started (refreshed once per poll). */
  elapsedMs: number;
  /** On-disk version reported by /health, null when unreachable. */
  serverVersion: string | null;
  /** APP_VERSION of the process that answered /health, if reported. */
  processVersion: string | null;
  /** true when the last poll could not reach the gateway (restarting). */
  unreachable: boolean;
  /** true once auto-refresh gave up; the user must reload manually. */
  timedOut: boolean;
};

type Listener = (update: VersionUpdate | null) => void;
type UpgradeListener = (state: UpgradeState | null) => void;

type ReloadAttempt = { serverVersion: string; at: number };

/** Shape of the JSON body returned by GET /health. */
type HealthSnapshot = {
  version?: string | null;
  /** APP_VERSION baked into the running gateway process. */
  processVersion?: string | null;
};

let pending: VersionUpdate | null = null;
const listeners = new Set<Listener>();

/** Last version `/health` reported; drives the pre-write guard. */
let lastServerVersion: string | null = null;

let upgradeTarget: string | null = null;
let upgradeTimer: number | null = null;
let upgradeState: UpgradeState | null = null;
const upgradeListeners = new Set<UpgradeListener>();

function isDismissed(serverVersion: string): boolean {
  try {
    return sessionStorage.getItem(`${DISMISS_KEY_PREFIX}${serverVersion}`) === "1";
  } catch {
    return false;
  }
}

function readReloadAttempt(): ReloadAttempt | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_ATTEMPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReloadAttempt;
    if (
      typeof parsed?.serverVersion !== "string" ||
      typeof parsed?.at !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const fn of listeners) fn(pending);
}

function emitUpgrade(): void {
  for (const fn of upgradeListeners) fn(upgradeState);
}

/**
 * The upgrade wait is otherwise invisible in devtools, which made a silent
 * hard-reload look like a "black screen". Log every poll so the console proves
 * the wait is alive.
 */
function logUpgrade(message: string, detail?: Record<string, unknown>): void {
  if (detail) console.info(`[upgrade] ${message}`, detail);
  else console.info(`[upgrade] ${message}`);
}

function stopUpgradeTimer(): void {
  if (upgradeTimer !== null) {
    window.clearTimeout(upgradeTimer);
    upgradeTimer = null;
  }
}

async function fetchHealthSnapshot(): Promise<HealthSnapshot | null> {
  try {
    // Avoid sticky cached /health after deploy (was causing update-modal loops).
    const res = await fetch("/health", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as HealthSnapshot;
    const version =
      (body.version ?? res.headers.get("X-App-Version"))?.trim() ?? null;
    if (version) lastServerVersion = version;
    return { version, processVersion: body.processVersion };
  } catch {
    return null;
  }
}

/**
 * The update is only "available" once the running process reports the target
 * version as its own processVersion. During a deploy the old process keeps
 * answering /health with the new on-disk version (mid-rsync) while it is still
 * serving old/partial assets, so a plain version match would reload too early
 * and land on the white screen.
 */
function isAvailable(target: string, health: HealthSnapshot): boolean {
  if (health.version?.trim() !== target) return false;
  return health.processVersion?.trim() === target;
}

/** Compare server version from API/health with the baked-in client version. */
export function checkServerVersion(serverVersion: string | null | undefined): void {
  const sv = serverVersion?.trim();
  if (!sv || sv === APP_VERSION) {
    if (pending) {
      pending = null;
      emit();
    }
    try {
      sessionStorage.removeItem(RELOAD_ATTEMPT_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  if (isDismissed(sv)) return;

  // Stop the update-modal loop: reload already ran for this server version but
  // assets/health still disagree (stale cache or mid-deploy split brain).
  const attempt = readReloadAttempt();
  if (
    attempt &&
    attempt.serverVersion === sv &&
    Date.now() - attempt.at < RELOAD_SUPPRESS_MS
  ) {
    dismissVersionUpdate(sv);
    return;
  }

  const next: VersionUpdate = { clientVersion: APP_VERSION, serverVersion: sv };
  if (
    pending?.clientVersion === next.clientVersion &&
    pending?.serverVersion === next.serverVersion
  ) {
    return;
  }
  pending = next;
  emit();
}

export function subscribeVersionUpdate(fn: Listener): () => void {
  listeners.add(fn);
  fn(pending);
  return () => listeners.delete(fn);
}

export function dismissVersionUpdate(serverVersion: string): void {
  try {
    sessionStorage.setItem(`${DISMISS_KEY_PREFIX}${serverVersion}`, "1");
  } catch {
    /* ignore */
  }
  if (pending?.serverVersion === serverVersion) {
    pending = null;
    emit();
  }
}

/** Hard navigation so HTML/JS are not served from a soft-reload / bfcache path. */
export function reloadForUpdate(serverVersion?: string): void {
  const sv = (serverVersion ?? pending?.serverVersion)?.trim();
  if (sv) {
    try {
      sessionStorage.setItem(
        RELOAD_ATTEMPT_KEY,
        JSON.stringify({ serverVersion: sv, at: Date.now() } satisfies ReloadAttempt),
      );
    } catch {
      /* ignore */
    }
  }
  const url = new URL(window.location.href);
  url.searchParams.set("_v", Date.now().toString());
  window.location.replace(url.toString());
}

/**
 * Start the "正在升级中，请等待" flow: keep polling /health until the new process
 * is actually serving the target version, then hard-reload. Call this from the
 * update modal's primary action instead of reloading immediately.
 */
export function beginUpgrade(serverVersion: string): void {
  const sv = serverVersion.trim();
  if (!sv) return;
  // Already waiting for this version: keep the counters, don't restart the wait.
  if (upgradeTarget === sv && upgradeState) return;
  upgradeTarget = sv;
  stopUpgradeTimer();
  upgradeState = {
    target: sv,
    startedAt: Date.now(),
    attempts: 0,
    elapsedMs: 0,
    serverVersion: null,
    processVersion: null,
    unreachable: false,
    timedOut: false,
  };
  logUpgrade(
    `waiting for ${sv} to serve; polling /health every ${UPGRADE_POLL_SECONDS}s`,
  );
  emitUpgrade();
  void pollForUpgrade(sv);
}

/** Stop waiting (manual reload / user dismissed the overlay). */
export function finishUpgrade(): void {
  upgradeTarget = null;
  upgradeState = null;
  stopUpgradeTimer();
  emitUpgrade();
}

export function subscribeUpgrade(fn: UpgradeListener): () => void {
  upgradeListeners.add(fn);
  fn(upgradeState);
  return () => upgradeListeners.delete(fn);
}

async function pollForUpgrade(target: string): Promise<void> {
  if (upgradeTarget !== target) return;
  const health = await fetchHealthSnapshot();
  if (upgradeTarget !== target) return;
  const state = upgradeState;
  if (!state) return;

  state.attempts += 1;
  state.elapsedMs = Date.now() - state.startedAt;
  state.unreachable = health === null;
  state.serverVersion = health?.version?.trim() ?? null;
  state.processVersion = health?.processVersion?.trim() ?? null;

  if (health && isAvailable(target, health)) {
    logUpgrade(`${target} is serving now, reloading`, {
      attempts: state.attempts,
      waitedSec: Math.round(state.elapsedMs / 1000),
    });
    upgradeTarget = null;
    upgradeState = null;
    stopUpgradeTimer();
    reloadForUpdate(target);
    return;
  }

  logUpgrade(`not ready yet (attempt ${state.attempts})`, {
    target,
    disk: state.serverVersion ?? "unreachable",
    process: state.processVersion ?? "—",
    waitedSec: Math.round(state.elapsedMs / 1000),
  });

  if (state.elapsedMs >= UPGRADE_MAX_WAIT_MS) {
    state.timedOut = true;
    logUpgrade(
      `giving up auto-refresh after ${Math.round(state.elapsedMs / 1000)}s; reload manually`,
    );
    stopUpgradeTimer();
    emitUpgrade();
    return;
  }

  emitUpgrade();
  upgradeTimer = window.setTimeout(
    () => void pollForUpgrade(target),
    UPGRADE_POLL_MS,
  );
}

export async function pollHealthVersion(): Promise<void> {
  const health = await fetchHealthSnapshot();
  if (!health) return;
  checkServerVersion(health.version);
}

// ---------------------------------------------------------------------------
// Write guard: a stale page must not persist edits.
//
// Two layers, same rule (page version === version the project serves):
//   1. `checkUiVersionForWrite()` — asked before the request is sent at all;
//   2. the gateway itself — the same header is verified for every write and
//      answers `ui-version-mismatch`, so the guard cannot be bypassed.
// Both funnel into `reportStaleWrite()`, which surfaces the "刷新页面" prompt.
// ---------------------------------------------------------------------------

/** Result of the pre-flight check that runs before every frontend write. */
export type UiVersionCheck =
  | { ok: true; serverVersion: string | null }
  | { ok: false; serverVersion: string; clientVersion: string };

/**
 * Is this page the version the project currently serves?
 *
 * Always re-reads `/health` (no-store): the tab may have been idle across a
 * deploy, and a cached answer would let a write through to a version it was not
 * rendered for. Only fresh evidence rejects — when the gateway is unreachable we
 * do not block, the request's own failure is the better error.
 */
export async function checkUiVersionForWrite(): Promise<UiVersionCheck> {
  const health = await fetchHealthSnapshot();
  const serverVersion = health?.version?.trim() ?? null;
  if (!serverVersion || serverVersion === APP_VERSION) {
    return { ok: true, serverVersion };
  }
  return { ok: false, serverVersion, clientVersion: APP_VERSION };
}

/** A write that was refused because the page is stale (never applied). */
export type StaleWriteNotice = {
  /** UI build that tried to write. */
  clientVersion: string;
  /** Version the project serves now; null when the gateway did not say. */
  serverVersion: string | null;
  /** Who refused it: our pre-flight, or the gateway's own guard. */
  source: "client" | "server";
  at: number;
};

let staleWrite: StaleWriteNotice | null = null;
const staleWriteListeners = new Set<(notice: StaleWriteNotice | null) => void>();

function emitStaleWrite(): void {
  for (const fn of staleWriteListeners) fn(staleWrite);
}

/**
 * Records a refused write so the UI can say "必须先刷新页面" instead of leaving
 * the user staring at a failed save. Also re-arms the update prompt for the
 * version we just learned about (a rejection is stronger evidence than a poll).
 */
export function reportStaleWrite(input: {
  clientVersion?: string | null;
  serverVersion?: string | null;
  source: "client" | "server";
}): StaleWriteNotice {
  const serverVersion = input.serverVersion?.trim() || null;
  if (serverVersion) lastServerVersion = serverVersion;
  const notice: StaleWriteNotice = {
    clientVersion: input.clientVersion?.trim() || APP_VERSION,
    serverVersion,
    source: input.source,
    at: Date.now(),
  };
  staleWrite = notice;
  if (serverVersion) checkServerVersion(serverVersion);
  console.warn("[write-guard] rejected a stale-page write", notice);
  emitStaleWrite();
  return notice;
}

/** User acknowledged the notice; writes stay blocked until the page is current. */
export function clearStaleWrite(): void {
  if (!staleWrite) return;
  staleWrite = null;
  emitStaleWrite();
}

export function subscribeStaleWrite(
  fn: (notice: StaleWriteNotice | null) => void,
): () => void {
  staleWriteListeners.add(fn);
  fn(staleWrite);
  return () => {
    staleWriteListeners.delete(fn);
  };
}
