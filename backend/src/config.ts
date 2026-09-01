import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  host: string;
  apiKey: string | undefined;
  agentWorkspace: string;
  model: string | undefined;
  dataDir: string;
  webDistDir: string;
}

function resolveFromBackend(...segments: string[]): string {
  return path.resolve(__dirname, "..", ...segments);
}

export function loadConfig(): Config {
  // Load .env if present (must run before reading process.env below).
  const envPath = resolveFromBackend(".env");
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch (err) {
      console.warn(`[config] failed to load ${envPath}:`, err);
    }
  }

  const rawWorkspace = process.env.AGENT_WORKSPACE || "../workspace";
  const agentWorkspace = path.isAbsolute(rawWorkspace)
    ? rawWorkspace
    : path.resolve(__dirname, "..", rawWorkspace);

  return {
    port: Number(process.env.PORT || 4211),
    host: process.env.HOST || "127.0.0.1",
    apiKey: process.env.CURSOR_API_KEY || undefined,
    agentWorkspace,
    model: process.env.CURSOR_MODEL || undefined,
    dataDir: resolveFromBackend("data"),
    webDistDir: resolveFromBackend("..", "web", "dist"),
  };
}
