/** Configuration loading: read settings from the environment (and an optional .env). */

import { readFileSync } from "node:fs";

export const DEFAULT_API_BASE = "https://api.eastagiletracker.com/api/v1";
export const DEFAULT_APP_BASE = "https://eastagiletracker.com";

/** Raised when required configuration is missing or invalid. */
export class ConfigError extends Error {}

/**
 * Resolved runtime configuration.
 *
 * @typedef {object} Config
 * @property {string} agentKey
 * @property {string} apiBase
 * @property {string} appBase
 */

/**
 * Load `KEY=VALUE` pairs from a .env file into `process.env`.
 *
 * Existing environment variables are never overridden. Blank lines and lines
 * starting with `#` are ignored; surrounding single/double quotes on values
 * are stripped. A missing file is a no-op.
 *
 * @param {string} [path]
 */
export function loadDotenv(path = ".env") {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // missing (or unreadable) file is a no-op
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const sep = line.indexOf("=");
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    value = value.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

/**
 * Build a {@link Config} from the environment, loading .env first if present.
 *
 * @param {string} [dotenvPath]
 * @returns {Config}
 */
export function loadConfig(dotenvPath = ".env") {
  loadDotenv(dotenvPath);
  const agentKey = (process.env.EAT_AGENT_KEY ?? "").trim();
  if (!agentKey) {
    throw new ConfigError(
      "EAT_AGENT_KEY is not set. Add it to your environment or a .env file (see .env.example).",
    );
  }
  const apiBase = (process.env.EAT_API_BASE ?? "").trim() || DEFAULT_API_BASE;
  const appBase = (process.env.EAT_APP_BASE ?? "").trim() || DEFAULT_APP_BASE;
  return Object.freeze({
    agentKey,
    apiBase: apiBase.replace(/\/+$/, ""),
    appBase: appBase.replace(/\/+$/, ""),
  });
}
