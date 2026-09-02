import { APP_VERSION } from "./version";

const DISMISS_KEY_PREFIX = "web-cursor:dismiss-update:";

export type VersionUpdate = {
  clientVersion: string;
  serverVersion: string;
};

type Listener = (update: VersionUpdate | null) => void;

let pending: VersionUpdate | null = null;
const listeners = new Set<Listener>();

function isDismissed(serverVersion: string): boolean {
  try {
    return sessionStorage.getItem(`${DISMISS_KEY_PREFIX}${serverVersion}`) === "1";
  } catch {
    return false;
  }
}

function emit(): void {
  for (const fn of listeners) fn(pending);
}

/** Compare server version from API/health with the baked-in client version. */
export function checkServerVersion(serverVersion: string | null | undefined): void {
  const sv = serverVersion?.trim();
  if (!sv || sv === APP_VERSION) {
    if (pending) {
      pending = null;
      emit();
    }
    return;
  }
  if (isDismissed(sv)) return;

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
export function reloadForUpdate(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("_v", Date.now().toString());
  window.location.replace(url.toString());
}

export async function pollHealthVersion(): Promise<void> {
  try {
    // Avoid sticky cached /health after deploy (was causing update-modal loops).
    const res = await fetch("/health", { cache: "no-store" });
    if (!res.ok) return;
    checkServerVersion(res.headers.get("X-App-Version"));
    const body = (await res.json()) as { version?: string };
    checkServerVersion(body.version);
  } catch {
    /* ignore */
  }
}
