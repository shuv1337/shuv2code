/**
 * Upstream Screenbox client (spec `docs/ade/ADE-V1-SPEC.md` §4.6, issues #139
 * / #132).
 *
 * Screenbox runs **unmodified and operator-run** (loopback compose stack) with
 * its internal policy loops off (`idle_pause_minutes=0`,
 * `auto_snapshot_minutes=0`, leases unused). ADE is its only client and drives
 * lifecycle through two upstream surfaces:
 *
 * - the **HTTP API** (`/api/desktop/*`, `/api/health`) for create / control /
 *   destroy / list — ADE's lifecycle plane;
 * - the **MCP endpoint** (`POST /mcp`, Streamable HTTP) for `tools/list` and
 *   `tools/call` — the tool plane ADE proxies for bots.
 *
 * **One credential, held server-side** (spec §4.6): the single upstream admin
 * token lives in this process only. It is sent as both `Authorization: Bearer`
 * and `X-API-Key` on every request because upstream splits the two planes:
 * the HTTP API's `_check_auth` reads `Authorization: Bearer` **only**, while
 * `X-API-Key` is honoured solely by the MCP middleware. Sending both is what
 * makes one token work across both planes. No Screenbox credential ever
 * reaches a bot session, a session config, or a client. Rotation is manual
 * token rotation, i.e. a restart with new env.
 *
 * Everything upstream-shaped is parsed defensively: this client owns the
 * boundary with a service ADE does not control, so unknown/renamed fields
 * degrade to `unknown` rather than crashing a tool call.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Env var naming the upstream Screenbox MCP/HTTP origin (e.g. `http://127.0.0.1:8080`). */
export const SCREENBOX_URL_ENV = "SCREENBOX_API_URL";
/** Env var carrying the single upstream admin token (`SCREENBOX_API_TOKEN` upstream-side). */
export const SCREENBOX_TOKEN_ENV = "SCREENBOX_API_TOKEN";

export const DEFAULT_SCREENBOX_REQUEST_TIMEOUT = Duration.seconds(30);

export interface AdeScreenboxConfigShape {
  /**
   * `null` when Screenbox is not deployed for this install. Deliberately not
   * defaulted to loopback: an unconfigured host must read as
   * `not-provisioned` (dormant), not as a red `down` pill, and must expose no
   * desktop tools at all.
   */
  readonly baseUrl: string | null;
  /** The single admin token; `null` only when upstream runs with auth disabled. */
  readonly adminToken: string | null;
  readonly requestTimeout: Duration.Duration;
}

const normalizeBaseUrl = (raw: string): string | null => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  try {
    // Reject anything that is not an absolute http(s) origin early — a
    // malformed value must not turn into a request against a relative URL.
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
};

/**
 * Whether a Screenbox origin is on this machine's loopback interface.
 *
 * The viewer proxy dials `127.0.0.1:<port>` with a port upstream chose. That is
 * only safe while upstream *is* this machine: against a remote or hostile
 * Screenbox, `vnc_port` becomes an attacker-chosen number and the proxy turns
 * into a raw byte pipe from any operate-scoped captain to an arbitrary port on
 * the ADE server's own loopback — every other local service included. The spec
 * says Screenbox is operator-run and loopback (§4.6); this makes that a checked
 * precondition of viewing rather than an assumption.
 */
export const isLoopbackScreenboxOrigin = (baseUrl: string | null): boolean => {
  if (baseUrl === null) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip the brackets Node keeps on IPv6 hostnames.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4 === null) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
};

export class AdeScreenboxConfig extends Context.Service<
  AdeScreenboxConfig,
  AdeScreenboxConfigShape
>()("shuv2code/ade/AdeScreenboxClient/AdeScreenboxConfig") {
  static readonly layer = (config: Partial<AdeScreenboxConfigShape> = {}) =>
    Layer.succeed(AdeScreenboxConfig, {
      baseUrl: config.baseUrl ?? null,
      adminToken: config.adminToken ?? null,
      requestTimeout: config.requestTimeout ?? DEFAULT_SCREENBOX_REQUEST_TIMEOUT,
    });

  /**
   * Reads {@link SCREENBOX_URL_ENV} / {@link SCREENBOX_TOKEN_ENV}. A value that
   * is present but unusable is logged loudly: silently degrading to
   * "not configured" would look identical to "no Screenbox here" while the
   * operator believes they deployed one.
   */
  static readonly layerFromEnv = (
    environment: Record<string, string | undefined> = process.env,
  ): Layer.Layer<AdeScreenboxConfig> =>
    Layer.effect(
      AdeScreenboxConfig,
      Effect.gen(function* () {
        const rawUrl = environment[SCREENBOX_URL_ENV];
        const rawToken = environment[SCREENBOX_TOKEN_ENV];
        const baseUrl = rawUrl === undefined ? null : normalizeBaseUrl(rawUrl);
        if (rawUrl !== undefined && rawUrl.trim().length > 0 && baseUrl === null) {
          yield* Effect.logWarning(
            `${SCREENBOX_URL_ENV} is set but is not an absolute http(s) origin; Screenbox stays dormant`,
            { value: rawUrl.slice(0, 120) },
          );
        }
        return {
          baseUrl,
          adminToken:
            rawToken === undefined || rawToken.trim().length === 0 ? null : rawToken.trim(),
          requestTimeout: DEFAULT_SCREENBOX_REQUEST_TIMEOUT,
        };
      }),
    );
}

// ---------------------------------------------------------------------------
// Errors & desktop state
// ---------------------------------------------------------------------------

/** Bound on upstream-supplied detail we keep (it can reach the model, scrubbed). */
export const SCREENBOX_DETAIL_MAX_LENGTH = 600;

export const boundScreenboxDetail = (detail: string): string =>
  detail.length <= SCREENBOX_DETAIL_MAX_LENGTH
    ? detail
    : `${detail.slice(0, SCREENBOX_DETAIL_MAX_LENGTH)}… (truncated)`;

/** Any failed interaction with upstream: transport, non-2xx, or malformed body. */
export class AdeScreenboxRequestError extends Schema.TaggedErrorClass<AdeScreenboxRequestError>()(
  "AdeScreenboxRequestError",
  {
    operation: Schema.String,
    status: Schema.NullOr(Schema.Number),
    detail: Schema.String,
  },
) {
  override get message(): string {
    const status = this.status === null ? "" : ` (status ${this.status})`;
    return `Screenbox ${this.operation} failed${status}: ${boundScreenboxDetail(this.detail)}`;
  }
}

/** Raised when Screenbox is not configured for this install. */
export class AdeScreenboxNotConfiguredError extends Schema.TaggedErrorClass<AdeScreenboxNotConfiguredError>()(
  "AdeScreenboxNotConfiguredError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Screenbox is not configured on this host (set ${SCREENBOX_URL_ENV}); cannot ${this.operation}.`;
  }
}

export type AdeScreenboxClientError = AdeScreenboxRequestError | AdeScreenboxNotConfiguredError;

/** Normalized upstream desktop lifecycle state. */
export type AdeScreenboxDesktopState =
  | "running"
  | "stopped"
  | "paused"
  | "saved"
  | "error"
  | "unknown";

export interface AdeScreenboxDesktop {
  readonly desktopId: string;
  readonly state: AdeScreenboxDesktopState;
  /**
   * Loopback port of the desktop's **raw RFB** listener, or `null` when
   * upstream omits it (a stopped desktop has no port bound).
   *
   * Upstream also reports `rdp_port` and `novnc_port`, and on a real host those
   * two are the *same* port — which speaks RDP, not HTTP and not RFB. Only
   * `vnc_port` is a VNC endpoint, so only `vnc_port` is read here; picking
   * either sibling would hand the viewer a socket that never sends `RFB 003.xxx`.
   */
  readonly vncPort: number | null;
}

const DESKTOP_STATES: ReadonlySet<AdeScreenboxDesktopState> = new Set<AdeScreenboxDesktopState>([
  "running",
  "stopped",
  "paused",
  "saved",
  "error",
]);

export const normalizeDesktopState = (raw: unknown): AdeScreenboxDesktopState => {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  if (DESKTOP_STATES.has(value as AdeScreenboxDesktopState)) {
    return value as AdeScreenboxDesktopState;
  }
  // Upstream also reports docker-ish synonyms.
  if (value === "exited" || value === "created") return "stopped";
  if (value === "starting" || value === "up") return "running";
  return "unknown";
};

const readRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (
  record: Record<string, unknown>,
  ...keys: ReadonlyArray<string>
): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
};

/** A TCP port upstream can actually have bound; anything else is not a port. */
const readPort = (
  record: Record<string, unknown>,
  ...keys: ReadonlyArray<string>
): number | null => {
  for (const key of keys) {
    const value = record[key];
    const port = typeof value === "string" ? Number(value) : value;
    if (typeof port !== "number") continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    return port;
  }
  return null;
};

/**
 * Upstream returns either a bare array or `{ desktops: [...] }`, with ids under
 * `desktop_id` or `id`. Entries we cannot identify are dropped rather than
 * guessed — a mis-parsed id would be a scoping hazard.
 */
export const parseDesktopList = (body: unknown): ReadonlyArray<AdeScreenboxDesktop> => {
  const record = readRecord(body);
  const rawList = Array.isArray(body) ? body : record === null ? null : record["desktops"];
  if (!Array.isArray(rawList)) return [];
  const desktops: Array<AdeScreenboxDesktop> = [];
  for (const entry of rawList) {
    const item = readRecord(entry);
    if (item === null) continue;
    const desktopId = readString(item, "desktop_id", "desktopId", "id", "name");
    if (desktopId === null) continue;
    desktops.push({
      desktopId,
      state: normalizeDesktopState(item["state"] ?? item["status"]),
      vncPort: readPort(item, "vnc_port", "vncPort"),
    });
  }
  return desktops;
};

export type AdeScreenboxControlAction = "start" | "stop" | "pause" | "resume";

/**
 * Parsed `GET /api/health`. Upstream answers **200 with `ok: false`** when it
 * is degraded (e.g. the desktop image is missing) rather than a non-2xx, so
 * status alone cannot tell healthy from broken — the body is the signal.
 */
export interface AdeScreenboxHealth {
  readonly ok: boolean;
  readonly desktops: number | null;
  readonly issues: ReadonlyArray<string>;
}

/** Bound on how many upstream `issues` entries are surfaced in a probe detail. */
export const SCREENBOX_HEALTH_ISSUE_LIMIT = 3;

/**
 * Missing/unknown-shaped bodies are read as healthy: an upstream that answers
 * 200 without the documented fields is reachable, and inventing a `down` pill
 * from a parse miss would be worse than trusting the status code.
 */
export const parseHealth = (body: unknown): AdeScreenboxHealth => {
  const record = readRecord(body);
  if (record === null) return { ok: true, desktops: null, issues: [] };
  const rawIssues = record["issues"];
  const issues = Array.isArray(rawIssues)
    ? rawIssues.filter((issue): issue is string => typeof issue === "string" && issue.length > 0)
    : [];
  const desktops = record["desktops"];
  return {
    ok: record["ok"] !== false,
    desktops: typeof desktops === "number" && Number.isFinite(desktops) ? desktops : null,
    issues,
  };
};

/** One-line, bounded rendering of an unhealthy health body for a Needs You pill. */
export const describeUnhealthy = (health: AdeScreenboxHealth): string => {
  if (health.issues.length === 0) return "Screenbox reports itself unhealthy (no detail given).";
  const shown = health.issues.slice(0, SCREENBOX_HEALTH_ISSUE_LIMIT).join("; ");
  const hidden =
    health.issues.length - Math.min(health.issues.length, SCREENBOX_HEALTH_ISSUE_LIMIT);
  return boundScreenboxDetail(
    hidden === 0 ? shown : `${shown} (+${hidden} more ${hidden === 1 ? "issue" : "issues"})`,
  );
};

/**
 * Upstream bodies have no schema ADE can trust, so they are decoded as unknown
 * and read defensively by the parsers above.
 */
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// ---------------------------------------------------------------------------
// MCP framing (Streamable HTTP)
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * A Streamable-HTTP MCP response is either a JSON body or an SSE stream whose
 * `data:` frames carry the JSON-RPC messages. Take the first frame that is a
 * JSON-RPC response (has `result` or `error`).
 *
 * Per the SSE spec an event's data field is the concatenation of *all* its
 * `data:` lines joined with newlines — a large `tools/list` result is commonly
 * split that way — so frames are accumulated until the blank line that ends the
 * event and only then parsed.
 */
export const parseMcpResponseBody = (contentType: string, text: string): unknown => {
  const looksLikeSse = contentType.includes("text/event-stream") || /^\s*event:/m.test(text);
  if (!looksLikeSse) {
    return JSON.parse(text) as unknown;
  }
  const lines = text.split(/\r?\n/);
  let frame: Array<string> = [];
  const takeFrame = (): unknown => {
    if (frame.length === 0) return undefined;
    const payload = frame.join("\n").trim();
    frame = [];
    if (payload.length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
    const record = readRecord(parsed);
    return record !== null && ("result" in record || "error" in record) ? parsed : undefined;
  };
  for (const line of lines) {
    if (line.startsWith("data:")) {
      // A single leading space after the colon is field padding, not content.
      frame.push(line.slice("data:".length).replace(/^ /, ""));
      continue;
    }
    if (line.trim().length === 0) {
      const parsed = takeFrame();
      if (parsed !== undefined) return parsed;
    }
  }
  const trailing = takeFrame();
  if (trailing !== undefined) return trailing;
  throw new Error("no JSON-RPC frame in SSE response");
};

export interface AdeScreenboxToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

const EMPTY_OBJECT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {},
};

export const parseToolsList = (result: unknown): ReadonlyArray<AdeScreenboxToolDescriptor> => {
  const record = readRecord(result);
  const rawTools = record === null ? null : record["tools"];
  if (!Array.isArray(rawTools)) return [];
  const tools: Array<AdeScreenboxToolDescriptor> = [];
  for (const entry of rawTools) {
    const item = readRecord(entry);
    if (item === null) continue;
    const name = readString(item, "name");
    if (name === null) continue;
    const parameters =
      readRecord(item["inputSchema"] ?? item["input_schema"] ?? item["parameters"]) ??
      EMPTY_OBJECT_SCHEMA;
    tools.push({
      name,
      description: readString(item, "description", "title") ?? name,
      parameters,
    });
  }
  return tools;
};

/** Flatten an MCP `tools/call` result into the text a model sees. */
export const parseToolCallResult = (
  result: unknown,
): { readonly text: string; readonly isError: boolean } => {
  const record = readRecord(result);
  if (record === null) return { text: "", isError: false };
  const isError = record["isError"] === true;
  const content = record["content"];
  if (!Array.isArray(content)) {
    return { text: typeof record["text"] === "string" ? record["text"] : "", isError };
  }
  const parts: Array<string> = [];
  for (const entry of content) {
    const item = readRecord(entry);
    if (item === null) continue;
    const text = item["text"];
    if (typeof text === "string") {
      parts.push(text);
      continue;
    }
    // Non-text content (images from `desktop_screenshot`) is summarized, not
    // inlined: the tool plane returns text to the model.
    const type = readString(item, "type") ?? "content";
    const mimeType = readString(item, "mimeType", "mime_type");
    parts.push(`[${type}${mimeType === null ? "" : ` ${mimeType}`}]`);
  }
  return { text: parts.join("\n"), isError };
};

// ---------------------------------------------------------------------------
// Client service
// ---------------------------------------------------------------------------

export interface AdeScreenboxClientShape {
  /** True when this install has an upstream origin configured at all. */
  readonly isConfigured: boolean;
  /**
   * Whether the configured Screenbox is on this machine's loopback interface.
   *
   * Carried here because this is where the base URL lives. The viewer proxy
   * needs it: it dials a loopback port that *upstream* chose, which is only
   * safe while upstream is this same machine (see
   * {@link isLoopbackScreenboxOrigin}).
   */
  readonly isLoopback: boolean;
  /**
   * `GET /api/health`. Resolves with the parsed body: upstream returns 200
   * even while degraded, so callers must read {@link AdeScreenboxHealth.ok}.
   */
  readonly health: Effect.Effect<AdeScreenboxHealth, AdeScreenboxClientError>;
  /** `GET /api/desktop/list`. */
  readonly listDesktops: Effect.Effect<ReadonlyArray<AdeScreenboxDesktop>, AdeScreenboxClientError>;
  /** `POST /api/desktop/create` — re-entrant upstream for a running desktop. */
  readonly createDesktop: (desktopId: string) => Effect.Effect<void, AdeScreenboxClientError>;
  /** `POST /api/desktop/control`. */
  readonly controlDesktop: (
    desktopId: string,
    action: AdeScreenboxControlAction,
  ) => Effect.Effect<void, AdeScreenboxClientError>;
  /** `POST /api/desktop/destroy` with `save_snapshot=false` (no snapshots in V1). */
  readonly destroyDesktop: (desktopId: string) => Effect.Effect<void, AdeScreenboxClientError>;
  /**
   * `POST /api/desktop/delete-data` — purges the dossier and *attempts* the
   * home volume. See the implementation note: upstream reports success even
   * when the volume survives.
   */
  readonly deleteDesktopData: (desktopId: string) => Effect.Effect<void, AdeScreenboxClientError>;
  /** MCP `tools/list` (unfiltered; the tool plane owns the operate-only subset). */
  readonly listTools: Effect.Effect<
    ReadonlyArray<AdeScreenboxToolDescriptor>,
    AdeScreenboxClientError
  >;
  /** MCP `tools/call`. Arguments are passed through verbatim by design. */
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<string, AdeScreenboxClientError>;
}

export class AdeScreenboxClient extends Context.Service<
  AdeScreenboxClient,
  AdeScreenboxClientShape
>()("shuv2code/ade/AdeScreenboxClient") {
  static readonly layer: Layer.Layer<
    AdeScreenboxClient,
    never,
    AdeScreenboxConfig | HttpClient.HttpClient
  > = Layer.effect(
    AdeScreenboxClient,
    Effect.gen(function* () {
      const config = yield* AdeScreenboxConfig;
      const httpClient = yield* HttpClient.HttpClient;
      return yield* makeAdeScreenboxClient(config, httpClient);
    }),
  );
}

/**
 * The two upstream planes disagree on the desktop-id field name, and getting
 * it wrong is silent-looking but total: the HTTP API reads `body.get("id")` on
 * create / control / destroy / delete-data and answers `400 Missing id` for
 * anything else, while MCP `tools/call` arguments use `desktop_id`. HTTP
 * bodies therefore carry `id` (required) plus `desktop_id` (ignored upstream,
 * kept so a body read in a log or a proxy is self-describing).
 */
export const withDesktopId = (desktopId: string): Readonly<Record<string, unknown>> => ({
  id: desktopId,
  desktop_id: desktopId,
});

export const makeAdeScreenboxClient = (
  config: AdeScreenboxConfigShape,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<AdeScreenboxClientShape> =>
  Effect.gen(function* () {
    const baseUrl = config.baseUrl;
    // Streamable HTTP may or may not hand out a session id; carry it when it
    // does so a stateful upstream accepts our subsequent calls.
    const mcpSessionId = yield* Ref.make<string | null>(null);
    const initialized = yield* Ref.make(false);
    const initMutex = Semaphore.makeUnsafe(1);
    let requestId = 0;

    const notConfigured = (operation: string) =>
      Effect.fail(new AdeScreenboxNotConfiguredError({ operation }));

    const withAuth = (request: HttpClientRequest.HttpClientRequest) =>
      config.adminToken === null
        ? request
        : request.pipe(
            // The HTTP API (`/api/*`) accepts `Authorization: Bearer` only;
            // `X-API-Key` is read by the MCP middleware only. Send both so the
            // single admin token authenticates on both planes.
            HttpClientRequest.bearerToken(config.adminToken),
            HttpClientRequest.setHeader("x-api-key", config.adminToken),
          );

    const execute = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      httpClient.execute(withAuth(request)).pipe(
        // Transport errors are normalized first so the timeout branch below is
        // the only other failure this can produce.
        Effect.mapError(
          (cause) =>
            new AdeScreenboxRequestError({ operation, status: null, detail: String(cause) }),
        ),
        Effect.timeoutOrElse({
          duration: config.requestTimeout,
          orElse: () =>
            Effect.fail(
              new AdeScreenboxRequestError({
                operation,
                status: null,
                detail: `timed out after ${Duration.toMillis(config.requestTimeout)}ms`,
              }),
            ),
        }),
      );

    /** Non-2xx carries the upstream body as detail (bounded) for Needs You. */
    const requireOk = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      response.status >= 200 && response.status < 300
        ? Effect.void
        : response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((text) =>
              Effect.fail(
                new AdeScreenboxRequestError({
                  operation,
                  status: response.status,
                  detail: boundScreenboxDetail(text.length === 0 ? "no response body" : text),
                }),
              ),
            ),
          );

    const httpJson = Effect.fn("AdeScreenboxClient.httpJson")(function* (input: {
      readonly operation: string;
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly body?: Readonly<Record<string, unknown>>;
    }) {
      if (baseUrl === null) return yield* notConfigured(input.operation);
      const url = `${baseUrl}${input.path}`;
      const base =
        input.method === "GET"
          ? Effect.succeed(HttpClientRequest.get(url))
          : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(input.body ?? {}));
      const request = yield* base.pipe(
        Effect.mapError(
          (cause) =>
            new AdeScreenboxRequestError({
              operation: input.operation,
              status: null,
              detail: String(cause),
            }),
        ),
      );
      const response = yield* execute(input.operation, request);
      yield* requireOk(input.operation, response);
      const text = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new AdeScreenboxRequestError({
              operation: input.operation,
              status: response.status,
              detail: String(cause),
            }),
        ),
      );
      if (text.trim().length === 0) return null;
      return yield* decodeUnknownJson(text).pipe(
        Effect.mapError(
          () =>
            new AdeScreenboxRequestError({
              operation: input.operation,
              status: response.status,
              detail: `malformed JSON body: ${boundScreenboxDetail(text)}`,
            }),
        ),
      );
    });

    const mcpCall = Effect.fn("AdeScreenboxClient.mcpCall")(function* (input: {
      readonly operation: string;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly notification?: boolean;
    }) {
      if (baseUrl === null) return yield* notConfigured(input.operation);
      requestId += 1;
      const payload: Record<string, unknown> = {
        jsonrpc: "2.0",
        method: input.method,
        params: input.params,
      };
      if (input.notification !== true) payload["id"] = requestId;
      const sessionId = yield* Ref.get(mcpSessionId);
      const request = yield* HttpClientRequest.post(`${baseUrl}/mcp`).pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.setHeader("mcp-protocol-version", MCP_PROTOCOL_VERSION),
        sessionId === null
          ? (self: HttpClientRequest.HttpClientRequest) => self
          : HttpClientRequest.setHeader("mcp-session-id", sessionId),
        HttpClientRequest.bodyJson(payload),
        Effect.mapError(
          (cause) =>
            new AdeScreenboxRequestError({
              operation: input.operation,
              status: null,
              detail: String(cause),
            }),
        ),
      );
      const response = yield* execute(input.operation, request);
      const returnedSession = response.headers["mcp-session-id"];
      if (typeof returnedSession === "string" && returnedSession.length > 0) {
        yield* Ref.set(mcpSessionId, returnedSession);
      }
      yield* requireOk(input.operation, response);
      if (input.notification === true) return null;
      const text = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new AdeScreenboxRequestError({
              operation: input.operation,
              status: response.status,
              detail: String(cause),
            }),
        ),
      );
      const parsed = yield* Effect.try({
        try: () => parseMcpResponseBody(response.headers["content-type"] ?? "", text),
        catch: (cause) =>
          new AdeScreenboxRequestError({
            operation: input.operation,
            status: response.status,
            detail: `malformed MCP response: ${String(cause)}`,
          }),
      });
      const record = readRecord(parsed);
      const error = record === null ? null : readRecord(record["error"]);
      if (error !== null) {
        return yield* new AdeScreenboxRequestError({
          operation: input.operation,
          status: response.status,
          detail: boundScreenboxDetail(
            readString(error, "message") ?? "upstream returned a JSON-RPC error",
          ),
        });
      }
      return record === null ? null : (record["result"] ?? null);
    });

    /**
     * Best-effort MCP handshake, once per process. A stateless upstream (the
     * compose default) answers `tools/list` without it; a stateful one needs
     * it. Failures are logged and swallowed so the real call still reports the
     * meaningful error.
     */
    const ensureInitialized = initMutex.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(initialized)) return;
        yield* Ref.set(initialized, true);
        yield* mcpCall({
          operation: "mcp initialize",
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "shuv2code-ade", version: "1" },
          },
        }).pipe(
          Effect.flatMap(() =>
            mcpCall({
              operation: "mcp initialized",
              method: "notifications/initialized",
              params: {},
              notification: true,
            }),
          ),
          Effect.catch((error) =>
            Effect.logDebug("Screenbox MCP handshake skipped", { error: error.message }),
          ),
        );
      }),
    );

    const listTools = ensureInitialized.pipe(
      Effect.andThen(mcpCall({ operation: "mcp tools/list", method: "tools/list", params: {} })),
      Effect.map(parseToolsList),
    );

    const callTool: AdeScreenboxClientShape["callTool"] = (input) =>
      ensureInitialized.pipe(
        Effect.andThen(
          mcpCall({
            operation: `mcp tools/call ${input.name}`,
            method: "tools/call",
            params: { name: input.name, arguments: input.arguments },
          }),
        ),
        Effect.flatMap((result) => {
          const parsed = parseToolCallResult(result);
          return parsed.isError
            ? Effect.fail(
                new AdeScreenboxRequestError({
                  operation: `mcp tools/call ${input.name}`,
                  status: null,
                  detail: boundScreenboxDetail(
                    parsed.text.length === 0 ? "upstream reported a tool error" : parsed.text,
                  ),
                }),
              )
            : Effect.succeed(parsed.text);
        }),
      );

    return {
      isConfigured: baseUrl !== null,
      isLoopback: isLoopbackScreenboxOrigin(baseUrl),
      health: httpJson({ operation: "health", method: "GET", path: "/api/health" }).pipe(
        Effect.map(parseHealth),
      ),
      listDesktops: httpJson({
        operation: "desktop list",
        method: "GET",
        path: "/api/desktop/list",
      }).pipe(Effect.map(parseDesktopList)),
      createDesktop: (desktopId) =>
        httpJson({
          operation: `desktop create ${desktopId}`,
          method: "POST",
          path: "/api/desktop/create",
          body: withDesktopId(desktopId),
        }).pipe(Effect.asVoid),
      controlDesktop: (desktopId, action) =>
        httpJson({
          operation: `desktop ${action} ${desktopId}`,
          method: "POST",
          path: "/api/desktop/control",
          body: { ...withDesktopId(desktopId), action },
        }).pipe(Effect.asVoid),
      destroyDesktop: (desktopId) =>
        httpJson({
          operation: `desktop destroy ${desktopId}`,
          method: "POST",
          path: "/api/desktop/destroy",
          // V1 has no snapshot feature (spec §4.6): never save one on destroy.
          // Upstream reads `auto_snapshot` and falls back to `save_snapshot`,
          // both defaulting to true, so this must be sent explicitly.
          body: { ...withDesktopId(desktopId), save_snapshot: false, confirm: true },
        }).pipe(Effect.asVoid),
      /**
       * Known upstream defect (accommodated, not worked around): delete-data
       * answers `{"deleted": true}` even when removing the home volume failed
       * silently — its docker-proxy whitelist has no `DELETE /volumes` entry,
       * so `screenbox-<id>-home` survives the purge and keeps the bot's data
       * on disk. ADE deliberately makes no docker calls and does not retry;
       * the operator workaround is `docker volume rm -f screenbox-<id>-home`
       * on the Screenbox host. `AdeScreenbox.destroyDesktopFor` logs that
       * hint on every successful delete.
       */
      deleteDesktopData: (desktopId) =>
        httpJson({
          operation: `desktop delete-data ${desktopId}`,
          method: "POST",
          path: "/api/desktop/delete-data",
          body: withDesktopId(desktopId),
        }).pipe(Effect.asVoid),
      listTools,
      callTool,
    } satisfies AdeScreenboxClientShape;
  });
