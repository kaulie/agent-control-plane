export type ServerMessage = { type: string } & Record<string, unknown>;

/**
 * Opens a WebSocket with automatic reconnection and invokes onMessage for
 * every server push. Returns a cleanup function that closes the socket and
 * stops reconnecting.
 */
export function connectWs(
  onMessage: (msg: ServerMessage) => void,
  onStatus?: (status: string) => void,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;

  const connect = (): void => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${window.location.host}/ws`);

    ws.onopen = () => {
      attempt = 0;
      onStatus?.("connected");
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data as string) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus?.("reconnecting");
      timer = window.setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10000));
    };
    ws.onerror = () => {
      /* onclose follows and triggers reconnect */
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer) window.clearTimeout(timer);
    ws?.close();
  };
}

