// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Minimal local reimplementation of `@opencode-ai/client/service` discover/ensure.
 * The published client package's Node ESM entry is currently broken
 * (`ERR_MODULE_NOT_FOUND` on extensionless generated imports), so shuv2code keeps this
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
export const OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES = 64 * 1024;

export class OpenCodeV2HealthResponseTooLargeError extends Error {
  readonly maximumBytes: number;
  readonly receivedBytes: number;

  constructor(input: { readonly maximumBytes: number; readonly receivedBytes: number }) {
    super(
      `OpenCode V2 health response exceeded ${input.maximumBytes} bytes ` +
        `(received at least ${input.receivedBytes}).`,
    );
    this.name = "OpenCodeV2HealthResponseTooLargeError";
    this.maximumBytes = input.maximumBytes;
    this.receivedBytes = input.receivedBytes;
  }
}

/** @internal Bounded separately from the larger compatibility API response budget. */
export async function readOpenCodeV2HealthResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw new OpenCodeV2HealthResponseTooLargeError({
      maximumBytes: OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES,
      receivedBytes: declaredLength,
    });
  }

  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const receivedBytes = bytes + next.value.byteLength;
      if (receivedBytes > OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES) {
        throw new OpenCodeV2HealthResponseTooLargeError({
          maximumBytes: OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES,
          receivedBytes,
        });
      }
      chunks.push(next.value);
      bytes = receivedBytes;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

export function openCodeV2StateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const stateHome =
    environment.XDG_STATE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".local", "state");
  return NodePath.join(stateHome, "opencode");
}

/**
 * OpenCode V2 registration filenames:
 * - stable channels `latest`/`next` → `service.json`
 * - other channels → `service-<channel>.json`
 * Dev builds use `0.0.0-<channel>-<stamp>` (e.g. next, local, integration-v2).
 * Published prereleases like `2.0.0-alpha-4` share the stable `service.json`
 * registration with plain `2.0.0` — they are not separate channels.
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
  // Dev/channel builds: 0.0.0-<channel>-<stamp>
  const devChannel = trimmed.match(/^0\.0\.0-([A-Za-z0-9._-]+)-\d+(?:\.\d+)?$/);
  if (devChannel?.[1]) {
    return devChannel[1];
  }
  // Published releases and prereleases (2.0.0, 2.0.0-alpha-4) share service.json.
  if (/^\d+\.\d+\.\d+/.test(trimmed)) {
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
    const raw = await NodeFSP.readFile(path, "utf8");
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
    const body = (await readOpenCodeV2HealthResponse(response)) as {
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

const SERVICE_REGISTRATION_FILE_RE = /^service(?:-[A-Za-z0-9._-]+)?\.json$/;
const STABLE_SERVICE_REGISTRATION = "service.json";
const LOCAL_SERVICE_REGISTRATION = "service-local.json";

/**
 * Prefer the binary's derived channel file, then the stable shared service,
 * then other channel registrations, and only then a local/dev service.
 *
 * Alphabetical fallback is unsafe: `service-local.json` sorts before
 * `service.json` (`-` < `.`), which made shuv2code attach to a bare local
 * OpenCode process that only exposes Zen models when the preferred channel
 * registration was missing.
 */
function registrationCandidateRank(fileName: string, preferred: string): number {
  if (fileName === preferred) {
    return 0;
  }
  if (fileName === STABLE_SERVICE_REGISTRATION) {
    return 1;
  }
  if (fileName === LOCAL_SERVICE_REGISTRATION) {
    return 3;
  }
  return 2;
}

/** @internal Order registration candidates: preferred channel, stable, others, local. */
export function orderOpenCodeV2RegistrationCandidates(
  fileNames: ReadonlyArray<string>,
  version: string | undefined,
): ReadonlyArray<string> {
  const preferred = openCodeV2ServiceRegistrationFileName(version);
  return [...fileNames]
    .filter((fileName) => SERVICE_REGISTRATION_FILE_RE.test(fileName))
    .sort((a, b) => {
      const rankDelta =
        registrationCandidateRank(a, preferred) - registrationCandidateRank(b, preferred);
      return rankDelta !== 0 ? rankDelta : a.localeCompare(b);
    });
}

async function scanOpenCodeV2ServiceRegistrations(
  input: DiscoverOpenCodeV2ServiceInput,
): Promise<OpenCodeV2ServiceEndpoint | null> {
  const directory = openCodeV2StateDirectory(input.environment);
  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(directory);
  } catch {
    return null;
  }
  for (const fileName of orderOpenCodeV2RegistrationCandidates(entries, input.version)) {
    const info = await readRegistrationFile(NodePath.join(directory, fileName));
    if (!info) {
      continue;
    }
    const endpoint = await probeRegistration(info);
    if (endpoint) {
      return endpoint;
    }
  }
  return null;
}

export async function discoverOpenCodeV2Service(
  input: DiscoverOpenCodeV2ServiceInput = {},
): Promise<OpenCodeV2ServiceEndpoint | null> {
  const path = resolveOpenCodeV2ServiceRegistrationPath(input);
  const info = await readRegistrationFile(path);
  if (info) {
    const exact = await probeRegistration(info, input.version);
    if (exact) {
      return exact;
    }
    // Dev builds version as 0.0.0-<channel>-<stamp>, so a service started from
    // an older build of the same channel disagrees on the stamp while being
    // fully compatible. Accept the healthy registration anyway.
    const relaxed = await probeRegistration(info);
    if (relaxed) {
      return relaxed;
    }
  }
  if (input.registrationFile?.trim()) {
    // An explicit registration file is an exact target; never scan past it.
    return null;
  }
  // The binary's channel can change between rebuilds (its derived registration
  // file then does not exist) while an older service keeps running under the
  // previous channel's registration. Fall back to any healthy registered
  // service instead of hard-failing on the derived filename.
  return scanOpenCodeV2ServiceRegistrations(input);
}

/**
 * Connect to an already-running OpenCode V2 background service.
 * Never spawns `serve` / `serve --service` — shuv2code attaches to the user's
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
