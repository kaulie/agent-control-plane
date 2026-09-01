import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

const OPEN = 1; // WebSocket.OPEN

/**
 * Registers the WebSocket endpoint and returns a broadcast function used by
 * the gateway to push real-time events to every connected browser.
 */
export function registerWebSocket(
  app: FastifyInstance,
): (message: Record<string, unknown>) => void {
  const clients = new Set<WebSocket>();

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  return (message: Record<string, unknown>): void => {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === OPEN) {
        client.send(data);
      }
    }
  };
}
