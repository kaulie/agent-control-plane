import type { AgentProvider } from "./types.js";
import {
  createProvider,
  type CreateProviderConfig,
  type ProviderName,
} from "./create-provider.js";

export const PROVIDER_NAMES: ProviderName[] = ["cursor", "cline"];

export function isProviderName(name: string): name is ProviderName {
  return (PROVIDER_NAMES as string[]).includes(name);
}

export function normalizeProviderName(
  name: string | undefined | null,
  fallback: string,
): string {
  const trimmed = name?.trim();
  return trimmed || fallback;
}

/**
 * Holds one live adapter instance per registered runtime.
 * Gateway resolves the correct provider from `task.provider` at run time.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  constructor(
    private readonly defaultName: string,
    adapters: AgentProvider[],
  ) {
    if (!adapters.length) {
      throw new Error("ProviderRegistry requires at least one adapter");
    }
    for (const adapter of adapters) {
      this.providers.set(adapter.name, adapter);
    }
    if (!this.providers.has(defaultName)) {
      throw new Error(
        `Default provider "${defaultName}" is not registered. ` +
          `Available: ${[...this.providers.keys()].join(", ")}`,
      );
    }
  }

  get defaultProviderName(): string {
    return this.defaultName;
  }

  get default(): AgentProvider {
    return this.get(this.defaultName);
  }

  has(name: string): boolean {
    return this.providers.has(name.trim());
  }

  get(name: string): AgentProvider {
    const key = name.trim();
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(
        `Unknown agent provider "${name}". Supported: ${[...this.providers.keys()].join(", ")}`,
      );
    }
    return provider;
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  async reconcileAfterRestart(
    orphans: Array<{ agentId: string; cwd: string; provider?: string }>,
  ): Promise<void> {
    const byProvider = new Map<string, Array<{ agentId: string; cwd: string }>>();
    for (const orphan of orphans) {
      const name = orphan.provider?.trim() || this.defaultName;
      const list = byProvider.get(name) ?? [];
      list.push({ agentId: orphan.agentId, cwd: orphan.cwd });
      byProvider.set(name, list);
    }
    for (const [name, list] of byProvider) {
      if (!this.has(name)) continue;
      await this.get(name).reconcileAfterRestart?.(list);
    }
    // Cline clears in-memory maps regardless of orphan list.
    if (this.has("cline") && !byProvider.has("cline")) {
      await this.get("cline").reconcileAfterRestart?.([]);
    }
  }

  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose?.();
    }
  }
}

/**
 * Build adapters for every known runtime and wrap them in a registry.
 * `AGENT_PROVIDER` (via `config.defaultName` / `config.name`) is the fallback
 * when a task/project does not pin a provider.
 */
export function createProviderRegistry(
  config: CreateProviderConfig & { defaultName?: string } = {},
): ProviderRegistry {
  const defaultName =
    normalizeProviderName(config.defaultName ?? config.name, "cursor");
  if (!isProviderName(defaultName)) {
    throw new Error(
      `Unknown default agent provider "${defaultName}". Supported: ${PROVIDER_NAMES.join(", ")}`,
    );
  }

  const adapters = PROVIDER_NAMES.map((name) =>
    createProvider({
      ...config,
      name,
    }),
  );
  return new ProviderRegistry(defaultName, adapters);
}
