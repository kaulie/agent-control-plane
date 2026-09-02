import type { AgentProvider } from "./types.js";
import { CursorProvider, type CursorProviderConfig } from "./cursor/index.js";

export type ProviderName = "cursor";

export interface CreateProviderConfig extends CursorProviderConfig {
  /** Adapter implementation to use. Defaults to `"cursor"`. */
  name?: ProviderName | string;
}

/**
 * Construct the configured AgentProvider (agent runtime adapter).
 * Add new runtimes here as additional `implements AgentProvider` classes.
 */
export function createProvider(config: CreateProviderConfig = {}): AgentProvider {
  const name = (config.name ?? "cursor").trim() || "cursor";
  switch (name) {
    case "cursor":
      return new CursorProvider({
        apiKey: config.apiKey,
        model: config.model,
      });
    default:
      throw new Error(
        `Unknown agent provider "${name}". Supported: cursor. ` +
          `Implement AgentProvider and register it in createProvider.`,
      );
  }
}
