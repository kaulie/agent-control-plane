import type { BillingService } from "../billing/service.js";
import type { AgentProvider } from "./types.js";
import { CursorProvider, type CursorProviderConfig } from "./cursor/index.js";
import { ClineProvider, type ClineProviderConfig } from "./cline/index.js";

export type ProviderName = "cursor" | "cline";

export interface CreateProviderConfig extends CursorProviderConfig {
  /** Adapter implementation to use. Defaults to `"cursor"`. */
  name?: ProviderName | string;
  /** 计费模块；两个适配器共用同一个实例（见 billing/README.md）。 */
  billing?: BillingService;
  /** Cline adapter config (used when `name === "cline"`). */
  cline?: ClineProviderConfig;
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
        billing: config.billing,
        model: config.model,
        gitViaProxyUrl: config.gitViaProxyUrl,
        gitViaProxyMcp: config.gitViaProxyMcp,
        gitViaProxyServerPath: config.gitViaProxyServerPath,
      });
    case "cline":
      return new ClineProvider({ ...config.cline, billing: config.billing });
    default:
      throw new Error(
        `Unknown agent provider "${name}". Supported: cursor, cline. ` +
          `Implement AgentProvider and register it in createProvider.`,
      );
  }
}
