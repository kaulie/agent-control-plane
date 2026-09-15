import { APP_VERSION } from "./version";

const DISMISS_KEY_PREFIX = "web-cursor:dismiss-update:";
const RELOAD_ATTEMPT_KEY = "web-cursor:reload-attempt";
/** After a reload for version V, suppress re-prompting V for this long. */
const RELOAD_SUPPRESS_MS = 60_000;
/** How often the update button polls /health before hard-reloading. */
const UPGRADE_POLL_MS = 1_000;

export type VersionUpdate = {
  clientVersion: string;
  serverVersion: string;
};

type Listener = (update: VersionUpdate | null) => void;

type ReloadAttempt = { serverVersion: string; at: number };

/** Shape of the JSON body returned by GET /health. */
type HealthSnapshot = {
  version?: string | null;
  /** APP_VERSION baked into the running gateway process. */
  processVersion?: string | null;
};

let pending: VersionUpdate | null = null;
const listeners = new Set<Listener>();

let upgradeTarget: string | null = null;
let upgradeTimer: number | null = null;

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
    return {
      version: body.version ?? res.headers.get("X-App-Version"),
      processVersion: body.processVersion,
    };
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
 * Start the "正在升级" flow: keep polling /health until the new process is
 * actually serving the target version, then hard-reload. Call this from the
 * update modal's primary action instead of reloading immediately.
 */
export function beginUpgrade(serverVersion: string): void {
  const sv = serverVersion.trim();
  if (!sv || upgradeTarget === sv) return;
  upgradeTarget = sv;
  stopUpgradeTimer();
  void pollForUpgrade(sv);
}

async function pollForUpgrade(target: string): Promise<void> {
  if (upgradeTarget !== target) return;
  const health = await fetchHealthSnapshot();
  if (upgradeTarget !== target) return;
  if (health && isAvailable(target, health)) {
    upgradeTarget = null;
    stopUpgradeTimer();
    reloadForUpdate(target);
    return;
  }
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
