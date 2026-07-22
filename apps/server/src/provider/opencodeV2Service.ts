// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off

import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

/**
 * Minimal local reimplementation of `@opencode-ai/client/service` discover/ensure.
 * The published client package's Node ESM entry is currently broken
 * (`ERR_MODULE_NOT_FOUND` on extensionless generated imports), so T3 keeps this
 * isolated helper instead of depending on that entrypoint.
 */

export interface OpenCodeV2ServiceEndpoint {
  readonly url: string;
  readonly password?: string;
  readonly version?: string;
  readonly pid: number;
}

export interface OpenCodeV2ServiceRegistration {
  readonly id?: string;
  readonly version?: string;
  readonly url: string;
  readonly pid: number;
  readonly password?: string;
}

export interface DiscoverOpenCodeV2ServiceInput {
  readonly version?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly registrationFile?: string;
}

const HEALTH_TIMEOUT_MS = 2_000;

export function openCodeV2StateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const stateHome =
    environment.XDG_STATE_HOME?.trim() || NodePath.join(NodeOs.homedir(), ".local", "state");
  return NodePath.join(stateHome, "opencode");
}

/**
 * OpenCode V2 registration filenames:
 * - stable channels `latest`/`next` → `service.json`
 * - other channels → `service-<channel>.json`
 * Prerelease builds use `0.0.0-<channel>-<stamp>` (e.g. next, local).
 */
export function openCodeV2ServiceRegistrationFileName(version: string | undefined): string {
  const channel = openCodeV2ChannelFromVersion(version);
  if (channel === "latest" || channel === "next") {
    return "service.json";
  }
  return `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
}

export function openCodeV2ChannelFromVersion(version: string | undefined): string {
  const trimmed = version?.trim() ?? "";
  if (trimmed.length === 0) {
    return "latest";
  }
  const prerelease = trimmed.match(/^0\.0\.0-([A-Za-z0-9._-]+)-\d+(?:\.\d+)?$/);
  if (prerelease?.[1]) {
    return prerelease[1];
  }
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return "latest";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function resolveOpenCodeV2ServiceRegistrationPath(input: {
  readonly version?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly registrationFile?: string;
}): string {
  if (input.registrationFile?.trim()) {
    return input.registrationFile.trim();
  }
  return NodePath.join(
    openCodeV2StateDirectory(input.environment),
    openCodeV2ServiceRegistrationFileName(input.version),
  );
}

export function parseOpenCodeV2ServiceRegistration(
  raw: string,
): OpenCodeV2ServiceRegistration | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.url !== "string" || parsed.url.trim().length === 0) {
      return null;
    }
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      url: parsed.url.trim(),
      pid: parsed.pid,
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
      ...(typeof parsed.password === "string" && parsed.password.length > 0
        ? { password: parsed.password }
        : {}),
    };
  } catch {
    return null;
  }
}

function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

async function readRegistrationFile(path: string): Promise<OpenCodeV2ServiceRegistration | null> {
  try {
    const raw = await NodeFs.readFile(path, "utf8");
    return parseOpenCodeV2ServiceRegistration(raw);
  } catch {
    return null;
  }
}

async function probeRegistration(
  info: OpenCodeV2ServiceRegistration,
  requiredVersion?: string,
): Promise<OpenCodeV2ServiceEndpoint | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/api/health", info.url), {
      headers: info.password ? { Authorization: basicAuthHeader(info.password) } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      healthy?: unknown;
      version?: unknown;
      pid?: unknown;
    };
    if (body.healthy !== true) {
      return null;
    }
    if (typeof body.pid === "number" && body.pid !== info.pid) {
      return null;
    }
    if (typeof body.version === "string") {
      if (info.version !== undefined && body.version !== info.version) {
        return null;
      }
      if (requiredVersion !== undefined && body.version !== requiredVersion) {
        return null;
      }
    }
    return {
      url: info.url,
      pid: info.pid,
      ...(info.password ? { password: info.password } : {}),
      ...(typeof body.version === "string"
        ? { version: body.version }
        : info.version
          ? { version: info.version }
          : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverOpenCodeV2Service(
  input: DiscoverOpenCodeV2ServiceInput = {},
): Promise<OpenCodeV2ServiceEndpoint | null> {
  const path = resolveOpenCodeV2ServiceRegistrationPath(input);
  const info = await readRegistrationFile(path);
  if (!info) {
    return null;
  }
  if (input.version !== undefined && info.version !== undefined && info.version !== input.version) {
    return null;
  }
  return probeRegistration(info, input.version);
}

/**
 * Connect to an already-running OpenCode V2 background service.
 * Never spawns `serve` / `serve --service` — T3 attaches to the user's
 * existing service (via `opencode service start`) so credentials and model
 * inventory stay shared.
 */
export async function requireOpenCodeV2Service(
  input: DiscoverOpenCodeV2ServiceInput = {},
): Promise<OpenCodeV2ServiceEndpoint> {
  const endpoint = await discoverOpenCodeV2Service(input);
  if (endpoint) {
    return endpoint;
  }
  const registrationPath = resolveOpenCodeV2ServiceRegistrationPath(input);
  throw new Error(
    `OpenCode V2 background service is not running or not healthy (registration: ${registrationPath}). Start it with \`opencode service start\` and retry.`,
  );
}

async function detectExternalServerProtocol(input: {
  readonly baseUrl: string;
  readonly serverPassword?: string;
}): Promise<"v1" | "v2"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const headers = input.serverPassword
    ? { Authorization: basicAuthHeader(input.serverPassword) }
    : undefined;
  try {
    const v2 = await fetch(new URL("/api/health", input.baseUrl), {
      headers,
      signal: controller.signal,
    });
    if (v2.ok) {
      return "v2";
    }
  } catch {
    // fall through
  } finally {
    clearTimeout(timer);
  }

  const legacyController = new AbortController();
  const legacyTimer = setTimeout(() => legacyController.abort(), HEALTH_TIMEOUT_MS);
  try {
    const v1 = await fetch(new URL("/global/health", input.baseUrl), {
      headers,
      signal: legacyController.signal,
    });
    if (v1.ok) {
      return "v1";
    }
  } catch {
    // fall through
  } finally {
    clearTimeout(legacyTimer);
  }

  return "v1";
}

export async function detectOpenCodeServerProtocol(input: {
  readonly baseUrl: string;
  readonly serverPassword?: string;
}): Promise<"v1" | "v2"> {
  return detectExternalServerProtocol(input);
}
