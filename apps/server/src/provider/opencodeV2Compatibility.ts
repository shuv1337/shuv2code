// @effect-diagnostics nodeBuiltinImport:off

import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStringDecoder from "node:string_decoder";

import type {
  Agent as OpenCodeV1Agent,
  OpencodeClient as OpenCodeV1Client,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2";

export interface OpenCodeV2BufferLimits {
  readonly responseBodyBytes: number;
  readonly sseEventBytes: number;
  readonly streamStateBytes: number;
  readonly activeStreamParts: number;
}

export const OPEN_CODE_V2_BUFFER_LIMITS: OpenCodeV2BufferLimits = {
  // History responses may contain several image/tool payloads. Keep this above the
  // 10 MiB per-image contract (plus base64 expansion) without leaving it unbounded.
  responseBodyBytes: 64 * 1024 * 1024,
  sseEventBytes: 16 * 1024 * 1024,
  streamStateBytes: 16 * 1024 * 1024,
  activeStreamParts: 256,
};

export class OpenCodeV2ResponseBodyTooLargeError extends Error {
  readonly maximumBytes: number;
  readonly receivedBytes: number;
  readonly resource: string;

  constructor(input: {
    readonly maximumBytes: number;
    readonly receivedBytes: number;
    readonly resource: string;
  }) {
    super(
      `OpenCode V2 response from ${input.resource} exceeded ${input.maximumBytes} bytes ` +
        `(received at least ${input.receivedBytes}).`,
    );
    this.name = "OpenCodeV2ResponseBodyTooLargeError";
    this.maximumBytes = input.maximumBytes;
    this.receivedBytes = input.receivedBytes;
    this.resource = input.resource;
  }
}

export class OpenCodeV2EventTooLargeError extends Error {
  readonly maximumBytes: number;
  readonly receivedBytes: number;

  constructor(input: { readonly maximumBytes: number; readonly receivedBytes: number }) {
    super(
      `OpenCode V2 SSE event exceeded ${input.maximumBytes} bytes ` +
        `(received at least ${input.receivedBytes}).`,
    );
    this.name = "OpenCodeV2EventTooLargeError";
    this.maximumBytes = input.maximumBytes;
    this.receivedBytes = input.receivedBytes;
  }
}

export class OpenCodeV2StreamStateOverflowError extends Error {
  readonly maximumBytes: number;
  readonly retainedBytes: number;
  readonly maximumActiveParts: number;
  readonly activeParts: number;

  constructor(input: {
    readonly maximumBytes: number;
    readonly retainedBytes: number;
    readonly maximumActiveParts: number;
    readonly activeParts: number;
  }) {
    super(
      `OpenCode V2 normalized stream state exceeded its limit ` +
        `(${input.retainedBytes}/${input.maximumBytes} bytes, ` +
        `${input.activeParts}/${input.maximumActiveParts} active parts).`,
    );
    this.name = "OpenCodeV2StreamStateOverflowError";
    this.maximumBytes = input.maximumBytes;
    this.retainedBytes = input.retainedBytes;
    this.maximumActiveParts = input.maximumActiveParts;
    this.activeParts = input.activeParts;
  }
}

function resolveOpenCodeV2BufferLimits(
  overrides: Partial<OpenCodeV2BufferLimits> | undefined,
): OpenCodeV2BufferLimits {
  const resolve = (name: keyof OpenCodeV2BufferLimits): number => {
    const value = overrides?.[name] ?? OPEN_CODE_V2_BUFFER_LIMITS[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`OpenCode V2 ${name} must be a positive safe integer.`);
    }
    return value;
  };
  return {
    responseBodyBytes: resolve("responseBodyBytes"),
    sseEventBytes: resolve("sseEventBytes"),
    streamStateBytes: resolve("streamStateBytes"),
    activeStreamParts: resolve("activeStreamParts"),
  };
}

interface V2CompatibilityClientInput {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
  /** @internal Primarily exposed so transport boundaries can be tested without giant fixtures. */
  readonly bufferLimits?: Partial<OpenCodeV2BufferLimits>;
}

interface V2ProviderInfo {
  readonly id: string;
  readonly name: string;
}

interface V2AgentInfo {
  readonly id: string;
  readonly description?: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
}

interface V2SkillInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly location: string;
  readonly content: string;
}

interface V2ModelInfo {
  readonly id: string;
  readonly providerID: string;
  readonly family?: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status: "alpha" | "beta" | "deprecated" | "active";
  readonly headers?: Record<string, string>;
  readonly capabilities: {
    readonly tools: boolean;
    readonly input: ReadonlyArray<string>;
    readonly output: ReadonlyArray<string>;
  };
  readonly variants?: ReadonlyArray<{ readonly id: string }>;
  readonly time: { readonly released: number };
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number };
}

interface V2SessionInfo {
  readonly id: string;
  readonly title: string;
  readonly location: { readonly directory: string };
}

type V2AssistantContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly state: unknown;
    };

interface V2MessageInfo {
  readonly id: string;
  readonly type: string;
  readonly time: { readonly created: number; readonly completed?: number };
  readonly text?: string;
  readonly content?: ReadonlyArray<V2AssistantContent>;
  readonly error?: { readonly type: string; readonly message: string };
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null) {
    params.append(key, "null");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item);
    return;
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) {
      appendQuery(params, `${key}[${child}]`, item);
    }
    return;
  }
  params.append(key, String(value));
}

function openHttpRequest(input: {
  readonly url: URL;
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}): Promise<NodeHttp.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = input.url.protocol === "https:" ? NodeHttps : NodeHttp;
    const request = transport.request(
      input.url,
      { method: input.method, headers: input.headers },
      resolve,
    );
    const abort = () => request.destroy(new Error("OpenCode V2 request aborted."));
    input.signal?.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => input.signal?.removeEventListener("abort", abort));
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

async function readResponseBody(
  response: NodeHttp.IncomingMessage,
  input: { readonly maximumBytes: number; readonly resource: string },
): Promise<string> {
  const declaredLength = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > input.maximumBytes) {
    response.destroy();
    throw new OpenCodeV2ResponseBodyTooLargeError({
      maximumBytes: input.maximumBytes,
      receivedBytes: declaredLength,
      resource: input.resource,
    });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const receivedBytes = bytes + encoded.byteLength;
    if (receivedBytes > input.maximumBytes) {
      response.destroy();
      throw new OpenCodeV2ResponseBodyTooLargeError({
        maximumBytes: input.maximumBytes,
        receivedBytes,
        resource: input.resource,
      });
    }
    chunks.push(encoded);
    bytes = receivedBytes;
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function makeOpenCodeV2Client(options: {
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly bufferLimits: OpenCodeV2BufferLimits;
}) {
  const request = async <A>(
    method: string,
    path: string,
    input?: {
      readonly query?: Record<string, unknown>;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly empty?: boolean;
    },
  ): Promise<A> => {
    const url = new URL(path, options.baseUrl);
    for (const [key, value] of Object.entries(input?.query ?? {})) {
      appendQuery(url.searchParams, key, value);
    }
    const encodedBody = input?.body === undefined ? undefined : JSON.stringify(input.body);
    const response = await openHttpRequest({
      url,
      method,
      ...(input?.signal ? { signal: input.signal } : {}),
      headers: {
        ...options.headers,
        ...(input?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(encodedBody === undefined ? {} : { body: encodedBody }),
    });
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      const encoded = await readResponseBody(response, {
        maximumBytes: options.bufferLimits.responseBodyBytes,
        resource: url.pathname,
      });
      const body = (() => {
        try {
          return JSON.parse(encoded) as unknown;
        } catch {
          return undefined;
        }
      })();
      if (body && typeof body === "object") {
        throw Object.assign(body, { status });
      }
      throw Object.assign(new Error(`OpenCode V2 request failed with status ${status}.`), {
        status,
      });
    }
    if (input?.empty || status === 204) {
      response.destroy();
      return undefined as A;
    }
    return JSON.parse(
      await readResponseBody(response, {
        maximumBytes: options.bufferLimits.responseBodyBytes,
        resource: url.pathname,
      }),
    ) as A;
  };

  const data = async <A>(
    method: string,
    path: string,
    input?: Parameters<typeof request>[2],
  ): Promise<A> => {
    const response = await request<{ readonly data: A }>(method, path, input);
    return response.data;
  };

  const eventSubscribe = (
    signal?: AbortSignal,
  ): AsyncIterable<{ type: string; data?: unknown }> => ({
    async *[Symbol.asyncIterator]() {
      const response = await openHttpRequest({
        url: new URL("/api/event", options.baseUrl),
        method: "GET",
        ...(signal ? { signal } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        throw new Error(`OpenCode V2 event subscription failed with status ${status}.`);
      }
      let buffer = "";
      const decoder = new NodeStringDecoder.StringDecoder("utf8");
      const assertEventSize = (encoded: string) => {
        const receivedBytes = Buffer.byteLength(encoded, "utf8");
        if (receivedBytes > options.bufferLimits.sseEventBytes) {
          throw new OpenCodeV2EventTooLargeError({
            maximumBytes: options.bufferLimits.sseEventBytes,
            receivedBytes,
          });
        }
      };
      const parseAvailableEvents = function* () {
        buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          assertEventSize(block);
          const encoded = block
            .split("\n")
            .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
            .join("\n");
          if (encoded.length > 0) {
            yield JSON.parse(encoded) as { type: string; data?: unknown };
          }
          boundary = buffer.indexOf("\n\n");
        }
        assertEventSize(buffer);
      };
      try {
        for await (const chunk of response) {
          buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          yield* parseAvailableEvents();
        }
        buffer += decoder.end();
        yield* parseAvailableEvents();
      } finally {
        response.destroy();
      }
    },
  });

  const sessionPath = (sessionID: string, suffix = "") =>
    `/api/session/${encodeURIComponent(sessionID)}${suffix}`;
  const locationQuery = (location: unknown) => ({ location });

  return {
    provider: {
      list: (input?: { readonly location?: unknown }) =>
        request<{ data: V2ProviderInfo[] }>("GET", "/api/provider", {
          query: locationQuery(input?.location),
        }),
    },
    model: {
      list: (input?: { readonly location?: unknown }) =>
        request<{ data: V2ModelInfo[] }>("GET", "/api/model", {
          query: locationQuery(input?.location),
        }),
    },
    agent: {
      list: (input?: { readonly location?: unknown }) =>
        request<{ data: V2AgentInfo[] }>("GET", "/api/agent", {
          query: locationQuery(input?.location),
        }),
    },
    skill: {
      list: (input?: { readonly location?: unknown }) =>
        request<{ data: V2SkillInfo[] }>("GET", "/api/skill", {
          query: locationQuery(input?.location),
        }),
    },
    event: {
      subscribe: (options?: { readonly signal?: AbortSignal }) => eventSubscribe(options?.signal),
    },
    mcp: {
      add: (input: {
        readonly server: string;
        readonly location?: unknown;
        readonly config: unknown;
      }) =>
        request<void>("PUT", `/api/mcp/${encodeURIComponent(input.server)}`, {
          query: locationQuery(input.location),
          body: { config: input.config },
          empty: true,
        }),
    },
    session: {
      active: () =>
        request<{ data: Record<string, { readonly type: "running" }> }>(
          "GET",
          "/api/session/active",
        ),
      get: (input: { readonly sessionID: string }) =>
        data<V2SessionInfo>("GET", sessionPath(input.sessionID)),
      create: (input?: { readonly location?: unknown }) =>
        data<V2SessionInfo>("POST", "/api/session", { body: input ?? {} }),
      fork: (input: { readonly sessionID: string }) =>
        data<V2SessionInfo>("POST", sessionPath(input.sessionID, "/fork"), { body: {} }),
      move: (input: { readonly sessionID: string; readonly directory: string }) =>
        request<void>("POST", sessionPath(input.sessionID, "/move"), {
          body: { directory: input.directory },
          empty: true,
        }),
      rename: (input: { readonly sessionID: string; readonly title: string }) =>
        request<void>("POST", sessionPath(input.sessionID, "/rename"), {
          body: { title: input.title },
          empty: true,
        }),
      switchModel: (input: { readonly sessionID: string; readonly model: unknown }) =>
        request<void>("POST", sessionPath(input.sessionID, "/model"), {
          body: { model: input.model },
          empty: true,
        }),
      switchAgent: (input: { readonly sessionID: string; readonly agent: string }) =>
        request<void>("POST", sessionPath(input.sessionID, "/agent"), {
          body: { agent: input.agent },
          empty: true,
        }),
      prompt: (input: { readonly sessionID: string } & Record<string, unknown>) =>
        data<unknown>("POST", sessionPath(input.sessionID, "/prompt"), {
          body: {
            text: input.text,
            files: input.files,
            agents: input.agents,
            delivery: input.delivery,
            resume: input.resume,
          },
        }),
      wait: (input: { readonly sessionID: string }) =>
        request<void>("POST", sessionPath(input.sessionID, "/wait"), { empty: true }),
      interrupt: (input: { readonly sessionID: string }) =>
        request<void>("POST", sessionPath(input.sessionID, "/interrupt"), { empty: true }),
      revert: {
        stage: (input: {
          readonly sessionID: string;
          readonly messageID: string;
          readonly files?: boolean;
        }) =>
          data<unknown>("POST", sessionPath(input.sessionID, "/revert/stage"), {
            body: { messageID: input.messageID, files: input.files },
          }),
        commit: (input: { readonly sessionID: string }) =>
          request<void>("POST", sessionPath(input.sessionID, "/revert/commit"), { empty: true }),
      },
    },
    message: {
      list: (input: { readonly sessionID: string; readonly order?: string }) =>
        request<{ data: V2MessageInfo[] }>("GET", sessionPath(input.sessionID, "/message"), {
          query: { order: input.order },
        }),
    },
    permission: {
      reply: (input: {
        readonly sessionID: string;
        readonly requestID: string;
        readonly reply: string;
      }) =>
        request<void>(
          "POST",
          sessionPath(input.sessionID, `/permission/${encodeURIComponent(input.requestID)}/reply`),
          { body: { reply: input.reply }, empty: true },
        ),
    },
    question: {
      reply: (input: {
        readonly sessionID: string;
        readonly requestID: string;
        readonly answers: ReadonlyArray<ReadonlyArray<string>>;
      }) =>
        request<void>(
          "POST",
          sessionPath(input.sessionID, `/question/${encodeURIComponent(input.requestID)}/reply`),
          { body: { answers: input.answers }, empty: true },
        ),
    },
  };
}

type OpenCodeV2Client = ReturnType<typeof makeOpenCodeV2Client>;

function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

function modelVariants(
  variants: ReadonlyArray<{ readonly id: string }> | undefined,
): Record<string, Record<string, never>> {
  return Object.fromEntries((variants ?? []).map((variant) => [variant.id, {}]));
}

async function loadV1ProviderList(
  client: OpenCodeV2Client,
  directory: string,
): Promise<ProviderListResponse> {
  const location = { directory };
  const [providersResult, modelsResult] = await Promise.all([
    client.provider.list({ location }),
    client.model.list({ location }),
  ]);
  const providersById = new Map<string, V2ProviderInfo>(
    providersResult.data.map((provider: V2ProviderInfo): [string, V2ProviderInfo] => [
      provider.id,
      provider,
    ]),
  );
  const allById = new Map<string, ProviderListResponse["all"][number]>();

  for (const model of modelsResult.data) {
    if (!model.enabled) {
      continue;
    }
    const provider = providersById.get(model.providerID);
    let entry = allById.get(model.providerID);
    if (!entry) {
      entry = {
        id: model.providerID,
        name: provider?.name ?? model.providerID,
        source: "config",
        env: [],
        options: {},
        models: {},
      };
      allById.set(model.providerID, entry);
    }
    entry.models[model.id] = {
      id: model.id,
      providerID: model.providerID,
      name: model.name,
      family: model.family,
      capabilities: {
        attachment:
          model.capabilities.input.includes("image") ||
          model.capabilities.input.includes("pdf") ||
          model.capabilities.input.includes("video"),
        reasoning: (model.variants?.length ?? 0) > 0,
        temperature: true,
        toolcall: model.capabilities.tools,
        input: {
          text: model.capabilities.input.includes("text"),
          audio: model.capabilities.input.includes("audio"),
          image: model.capabilities.input.includes("image"),
          video: model.capabilities.input.includes("video"),
          pdf: model.capabilities.input.includes("pdf"),
        },
        output: {
          text: model.capabilities.output.includes("text"),
          audio: model.capabilities.output.includes("audio"),
          image: model.capabilities.output.includes("image"),
          video: model.capabilities.output.includes("video"),
          pdf: model.capabilities.output.includes("pdf"),
        },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: model.limit,
      status: model.status,
      options: {},
      headers: model.headers ?? {},
      release_date: String(model.time.released),
      variants: modelVariants(model.variants),
    } as unknown as ProviderListResponse["all"][number]["models"][string];
  }

  const all = [...allById.values()];
  return {
    all,
    default: {},
    connected: all.map((provider) => provider.id),
  };
}

async function loadV1Agents(
  client: OpenCodeV2Client,
  directory: string,
): Promise<ReadonlyArray<OpenCodeV1Agent>> {
  const result = await client.agent.list({ location: { directory } });
  return result.data.map(
    (agent: V2AgentInfo) =>
      ({
        name: agent.id,
        description: agent.description,
        mode: agent.mode,
        hidden: agent.hidden,
        permission: [],
        options: {},
      }) as OpenCodeV1Agent,
  );
}

function toV1Session(session: Awaited<ReturnType<OpenCodeV2Client["session"]["get"]>>) {
  return {
    ...session,
    directory: session.location.directory,
  };
}

function toPromptInput(input: Record<string, unknown>) {
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const text = parts
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { readonly type?: unknown }).type === "text" &&
        typeof (part as { readonly text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
  const files = parts.flatMap((part) => {
    if (
      typeof part !== "object" ||
      part === null ||
      (part as { readonly type?: unknown }).type !== "file" ||
      typeof (part as { readonly url?: unknown }).url !== "string"
    ) {
      return [];
    }
    const file = part as { readonly url: string; readonly filename?: string };
    return [{ uri: file.url, ...(file.filename ? { name: file.filename } : {}) }];
  });
  return { text, ...(files.length > 0 ? { files } : {}) };
}

async function applySessionSelection(client: OpenCodeV2Client, input: Record<string, unknown>) {
  const sessionID = String(input.sessionID);
  const model = input.model as { providerID?: string; modelID?: string } | undefined;
  if (model?.providerID && model.modelID) {
    await client.session.switchModel({
      sessionID,
      model: {
        providerID: model.providerID,
        id: model.modelID,
        ...(typeof input.variant === "string" ? { variant: input.variant } : {}),
      },
    });
  }
  if (typeof input.agent === "string" && input.agent.length > 0) {
    await client.session.switchAgent({ sessionID, agent: input.agent });
  }
}

function toV1MessageEntry(message: V2MessageInfo) {
  if (message.type === "user") {
    return {
      info: {
        id: message.id,
        role: "user" as const,
        time: message.time,
      },
      parts: [{ id: `${message.id}-text`, type: "text" as const, text: message.text }],
    };
  }
  if (message.type !== "assistant") {
    return {
      info: { id: message.id, role: "system" as const, time: message.time },
      parts: [],
    };
  }

  return {
    info: {
      id: message.id,
      role: "assistant" as const,
      time: message.time,
      ...(message.error
        ? { error: { name: message.error.type, data: { message: message.error.message } } }
        : {}),
    },
    parts: (message.content ?? []).map((part: V2AssistantContent, index: number) => {
      if (part.type === "text" || part.type === "reasoning") {
        return {
          id: `${message.id}-${part.type}-${index}`,
          messageID: message.id,
          type: part.type,
          text: part.text,
        };
      }
      return {
        id: part.id,
        messageID: message.id,
        type: "tool",
        callID: part.id,
        tool: part.name,
        state: part.state,
      };
    }),
  };
}

interface V2StreamEvent {
  readonly type: string;
  readonly created?: number;
  readonly data?: unknown;
}

interface V2StreamState {
  readonly limits: OpenCodeV2BufferLimits;
  retainedBytes: number;
  readonly text: Map<
    string,
    {
      readonly partID: string;
      readonly sessionID: string;
      readonly started: number;
      text: string;
      bytes: number;
      initialized: boolean;
    }
  >;
  readonly tools: Map<
    string,
    {
      readonly partID: string;
      readonly sessionID: string;
      readonly messageID: string;
      readonly callID: string;
      readonly started: number;
      name: string;
      input: Record<string, unknown>;
      inputBytes: number;
    }
  >;
}

function activeStreamParts(state: V2StreamState): number {
  return state.text.size + state.tools.size;
}

function assertStreamStateCapacity(
  state: V2StreamState,
  input: { readonly retainedBytes: number; readonly activeParts?: number },
): void {
  const activeParts = input.activeParts ?? activeStreamParts(state);
  if (
    input.retainedBytes > state.limits.streamStateBytes ||
    activeParts > state.limits.activeStreamParts
  ) {
    throw new OpenCodeV2StreamStateOverflowError({
      maximumBytes: state.limits.streamStateBytes,
      retainedBytes: input.retainedBytes,
      maximumActiveParts: state.limits.activeStreamParts,
      activeParts,
    });
  }
}

function serializedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 0 : Buffer.byteLength(encoded, "utf8");
}

function releaseSessionStreamState(state: V2StreamState, sessionID: string): void {
  for (const [key, text] of state.text) {
    if (text.sessionID !== sessionID) continue;
    state.retainedBytes -= text.bytes;
    state.text.delete(key);
  }
  for (const [key, tool] of state.tools) {
    if (tool.sessionID !== sessionID) continue;
    state.retainedBytes -= tool.inputBytes;
    state.tools.delete(key);
  }
}

function eventData(event: V2StreamEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object"
    ? (event.data as Record<string, unknown>)
    : {};
}

function v2PartKey(input: {
  readonly sessionID: string;
  readonly messageID: string;
  readonly kind: string;
  readonly ordinal: number | string;
}): string {
  return `${input.sessionID}:${input.messageID}:${input.kind}:${input.ordinal}`;
}

function v2PartID(messageID: string, kind: string, ordinal: number | string): string {
  return `prt_${messageID.replace(/^msg_?/, "")}_${kind}_${ordinal}`;
}

function assistantMessageUpdated(sessionID: string, messageID: string) {
  return {
    type: "message.updated",
    properties: { sessionID, info: { id: messageID, role: "assistant" } },
  };
}

function normalizeV2Events(
  event: V2StreamEvent,
  state: V2StreamState,
): ReadonlyArray<{ readonly type: string; readonly properties: Record<string, unknown> }> {
  const data = eventData(event);
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
  const created = typeof event.created === "number" ? event.created : 0;

  const questionEventType = (() => {
    switch (event.type) {
      case "question.v2.asked":
        return "question.asked";
      case "question.v2.replied":
        return "question.replied";
      case "question.v2.rejected":
        return "question.rejected";
      default:
        return undefined;
    }
  })();
  if (questionEventType) {
    return [{ type: questionEventType, properties: data }];
  }

  if (event.type === "session.execution.started" && sessionID) {
    return [{ type: "session.status", properties: { sessionID, status: { type: "busy" } } }];
  }
  if (
    (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") &&
    sessionID
  ) {
    releaseSessionStreamState(state, sessionID);
  }
  if (event.type === "session.execution.succeeded" && sessionID) {
    return [{ type: "session.status", properties: { sessionID, status: { type: "idle" } } }];
  }
  if (event.type === "permission.asked" && sessionID) {
    return [
      {
        type: event.type,
        properties: {
          ...data,
          permission:
            typeof data.action === "string"
              ? data.action
              : typeof data.permission === "string"
                ? data.permission
                : "unknown",
          patterns: Array.isArray(data.resources)
            ? data.resources
            : Array.isArray(data.patterns)
              ? data.patterns
              : [],
        },
      },
    ];
  }

  const textMatch = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(event.type);
  if (textMatch && sessionID && typeof data.assistantMessageID === "string") {
    const kind = textMatch[1]!;
    const phase = textMatch[2]!;
    const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
    const key = v2PartKey({
      sessionID,
      messageID: data.assistantMessageID,
      kind,
      ordinal,
    });
    let textState = state.text.get(key);
    if (!textState) {
      assertStreamStateCapacity(state, {
        retainedBytes: state.retainedBytes,
        activeParts: activeStreamParts(state) + 1,
      });
      textState = {
        partID: v2PartID(data.assistantMessageID, kind, ordinal),
        sessionID,
        started: created,
        text: "",
        bytes: 0,
        initialized: false,
      };
      state.text.set(key, textState);
    }
    const initialize = () => {
      if (textState!.initialized) return [];
      textState!.initialized = true;
      return [
        assistantMessageUpdated(sessionID, data.assistantMessageID as string),
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: textState!.partID,
              sessionID,
              messageID: data.assistantMessageID,
              type: kind,
              text: textState!.text,
              time: { start: textState!.started },
            },
          },
        },
      ];
    };

    if (phase === "started") {
      return initialize();
    }
    if (phase === "delta" && typeof data.delta === "string") {
      const events = initialize();
      const deltaBytes = Buffer.byteLength(data.delta, "utf8");
      assertStreamStateCapacity(state, {
        retainedBytes: state.retainedBytes + deltaBytes,
      });
      textState.text += data.delta;
      textState.bytes += deltaBytes;
      state.retainedBytes += deltaBytes;
      return [
        ...events,
        {
          type: "message.part.delta",
          properties: { sessionID, partID: textState.partID, delta: data.delta },
        },
      ];
    }
    if (phase === "ended") {
      const events = initialize();
      if (typeof data.text === "string") {
        const replacementBytes = Buffer.byteLength(data.text, "utf8");
        assertStreamStateCapacity(state, {
          retainedBytes: state.retainedBytes - textState.bytes + replacementBytes,
        });
        state.retainedBytes = state.retainedBytes - textState.bytes + replacementBytes;
        textState.text = data.text;
        textState.bytes = replacementBytes;
      }
      const completed = [
        ...events,
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: textState.partID,
              sessionID,
              messageID: data.assistantMessageID,
              type: kind,
              text: textState.text,
              time: { start: textState.started, end: created },
            },
          },
        },
      ];
      state.text.delete(key);
      state.retainedBytes -= textState.bytes;
      return completed;
    }
  }

  const toolMatch = /^session\.tool\.(input\.started|called|progress|success|failed)$/.exec(
    event.type,
  );
  if (
    toolMatch &&
    sessionID &&
    typeof data.assistantMessageID === "string" &&
    typeof data.callID === "string"
  ) {
    const key = v2PartKey({
      sessionID,
      messageID: data.assistantMessageID,
      kind: "tool",
      ordinal: data.callID,
    });
    let tool = state.tools.get(key);
    if (!tool) {
      assertStreamStateCapacity(state, {
        retainedBytes: state.retainedBytes,
        activeParts: activeStreamParts(state) + 1,
      });
      tool = {
        partID: v2PartID(data.assistantMessageID, "tool", data.callID),
        sessionID,
        messageID: data.assistantMessageID,
        callID: data.callID,
        started: created,
        name: typeof data.name === "string" ? data.name : "tool",
        input: {},
        inputBytes: 0,
      };
      state.tools.set(key, tool);
    }
    if (typeof data.name === "string") tool.name = data.name;
    if (data.input && typeof data.input === "object" && !Array.isArray(data.input)) {
      const inputBytes = serializedBytes(data.input);
      assertStreamStateCapacity(state, {
        retainedBytes: state.retainedBytes - tool.inputBytes + inputBytes,
      });
      state.retainedBytes = state.retainedBytes - tool.inputBytes + inputBytes;
      tool.input = data.input as Record<string, unknown>;
      tool.inputBytes = inputBytes;
    }
    const basePart = {
      id: tool.partID,
      sessionID,
      messageID: tool.messageID,
      type: "tool",
      callID: tool.callID,
      tool: tool.name,
    };
    const prefix = [assistantMessageUpdated(sessionID, tool.messageID)];
    if (toolMatch[1] === "input.started") {
      return [
        ...prefix,
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: { ...basePart, state: { status: "pending", input: {}, raw: "" } },
          },
        },
      ];
    }
    if (toolMatch[1] === "called" || toolMatch[1] === "progress") {
      return [
        ...prefix,
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              ...basePart,
              state: {
                status: "running",
                input: tool.input,
                title: tool.name,
                metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {},
                time: { start: tool.started },
              },
            },
          },
        },
      ];
    }
    const content = Array.isArray(data.content) ? data.content : [];
    const output = content
      .flatMap((item) =>
        item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
          ? [(item as { text: string }).text]
          : [],
      )
      .join("\n");
    const failed = toolMatch[1] === "failed";
    const error =
      data.error &&
      typeof data.error === "object" &&
      typeof (data.error as { message?: unknown }).message === "string"
        ? (data.error as { message: string }).message
        : "OpenCode tool failed.";
    const completed = [
      ...prefix,
      {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            ...basePart,
            state: failed
              ? {
                  status: "error",
                  input: tool.input,
                  error,
                  metadata: data.metadata ?? {},
                  time: { start: tool.started, end: created },
                }
              : {
                  status: "completed",
                  input: tool.input,
                  output,
                  title: tool.name,
                  metadata: data.metadata ?? {},
                  time: { start: tool.started, end: created },
                },
          },
        },
      },
    ];
    state.tools.delete(key);
    state.retainedBytes -= tool.inputBytes;
    return completed;
  }

  return [{ type: event.type, properties: data }];
}

/**
 * Adapts the OpenCode V2 client to the subset of the V1 SDK surface consumed by
 * shuv2code. Keeping this boundary in one place lets the existing event projection
 * and provider adapter continue to serve both protocol generations.
 */
export function createOpenCodeV2CompatibilityClient(
  input: V2CompatibilityClientInput,
): OpenCodeV1Client {
  const bufferLimits = resolveOpenCodeV2BufferLimits(input.bufferLimits);
  const client = makeOpenCodeV2Client({
    baseUrl: input.baseUrl,
    bufferLimits,
    ...(input.serverPassword
      ? { headers: { Authorization: basicAuthHeader(input.serverPassword) } }
      : {}),
  });
  const permissionSessions = new Map<string, string>();
  const questionSessions = new Map<string, string>();

  const compatibilityClient = {
    provider: {
      list: async () => ({ data: await loadV1ProviderList(client, input.directory) }),
    },
    app: {
      agents: async () => ({ data: await loadV1Agents(client, input.directory) }),
      skills: async () => {
        const result = await client.skill.list({ location: { directory: input.directory } });
        return { data: result.data };
      },
    },
    event: {
      subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => {
        const source = client.event.subscribe(
          options?.signal ? { signal: options.signal } : undefined,
        );
        async function* stream() {
          const state: V2StreamState = {
            limits: bufferLimits,
            retainedBytes: 0,
            text: new Map(),
            tools: new Map(),
          };
          for await (const event of source) {
            const eventData =
              event.data && typeof event.data === "object"
                ? (event.data as Record<string, unknown>)
                : undefined;
            if (
              (event.type === "permission.v2.asked" || event.type === "permission.asked") &&
              typeof eventData?.id === "string" &&
              typeof eventData.sessionID === "string"
            ) {
              if (
                !permissionSessions.has(eventData.id) &&
                permissionSessions.size + questionSessions.size >= bufferLimits.activeStreamParts
              ) {
                throw new OpenCodeV2StreamStateOverflowError({
                  maximumBytes: bufferLimits.streamStateBytes,
                  retainedBytes: 0,
                  maximumActiveParts: bufferLimits.activeStreamParts,
                  activeParts: permissionSessions.size + questionSessions.size + 1,
                });
              }
              permissionSessions.set(eventData.id, eventData.sessionID);
            }
            if (
              (event.type === "question.v2.asked" || event.type === "question.asked") &&
              typeof eventData?.id === "string" &&
              typeof eventData.sessionID === "string"
            ) {
              if (
                !questionSessions.has(eventData.id) &&
                permissionSessions.size + questionSessions.size >= bufferLimits.activeStreamParts
              ) {
                throw new OpenCodeV2StreamStateOverflowError({
                  maximumBytes: bufferLimits.streamStateBytes,
                  retainedBytes: 0,
                  maximumActiveParts: bufferLimits.activeStreamParts,
                  activeParts: permissionSessions.size + questionSessions.size + 1,
                });
              }
              questionSessions.set(eventData.id, eventData.sessionID);
            }
            if (
              (event.type === "session.execution.succeeded" ||
                event.type === "session.execution.failed") &&
              typeof eventData?.sessionID === "string"
            ) {
              for (const [requestID, ownerSessionID] of permissionSessions) {
                if (ownerSessionID === eventData.sessionID) permissionSessions.delete(requestID);
              }
              for (const [requestID, ownerSessionID] of questionSessions) {
                if (ownerSessionID === eventData.sessionID) questionSessions.delete(requestID);
              }
            }
            for (const normalized of normalizeV2Events(event, state)) {
              yield normalized;
            }
          }
        }
        return { stream: stream() };
      },
    },
    mcp: {
      add: async (request: { readonly name: string; readonly config: unknown }) => {
        await client.mcp.add({
          server: request.name,
          location: { directory: input.directory },
          config: request.config as Parameters<typeof client.mcp.add>[0]["config"],
        });
        return { data: true };
      },
    },
    session: {
      get: async (request: { readonly sessionID: string }) => ({
        data: toV1Session(await client.session.get(request)),
      }),
      // Map V2's /api/session/active onto the V1-shaped session.status response
      // so callers can probe which durable sessions are still executing after a
      // reconnect without depending on live event delivery.
      status: async () => {
        const active = await client.session.active();
        const data: Record<string, { readonly type: "busy" | "idle" }> = {};
        for (const sessionID of Object.keys(active.data ?? {})) {
          data[sessionID] = { type: "busy" };
        }
        return { data };
      },
      wait: async (request: { readonly sessionID: string }) => {
        await client.session.wait(request);
        return { data: true };
      },
      // V2 has no per-session permission-ruleset update. shuv2code still calls this
      // after create/resume; keep a no-op so V1 call sites compile, and rely on
      // V2 agent defaults plus permission.asked / question.asked events.
      update: async () => ({ data: true }),
      fork: async (request: { readonly sessionID: string; readonly directory?: string }) => {
        const session = await client.session.fork({ sessionID: request.sessionID });
        if (request.directory && request.directory !== session.location.directory) {
          await client.session.move({ sessionID: session.id, directory: request.directory });
          return { data: toV1Session(await client.session.get({ sessionID: session.id })) };
        }
        return { data: toV1Session(session) };
      },
      create: async (request: { readonly title?: string }) => {
        const session = await client.session.create({ location: { directory: input.directory } });
        if (request.title) {
          await client.session.rename({ sessionID: session.id, title: request.title });
        }
        return { data: toV1Session(session) };
      },
      abort: async (request: { readonly sessionID: string }) => {
        await client.session.interrupt(request);
        return { data: true };
      },
      promptAsync: async (request: Record<string, unknown>) => {
        await applySessionSelection(client, request);
        await client.session.prompt({
          sessionID: String(request.sessionID),
          ...toPromptInput(request),
        });
        return { data: true };
      },
      prompt: async (request: Record<string, unknown>) => {
        await applySessionSelection(client, request);
        const sessionID = String(request.sessionID);
        await client.session.prompt({ sessionID, ...toPromptInput(request) });
        await client.session.wait({ sessionID });
        const messages = await client.message.list({ sessionID, order: "desc" });
        const assistant = messages.data.find(
          (message: V2MessageInfo) => message.type === "assistant",
        );
        return { data: assistant ? toV1MessageEntry(assistant) : undefined };
      },
      messages: async (request: { readonly sessionID: string }) => {
        const messages = await client.message.list({ sessionID: request.sessionID, order: "asc" });
        return { data: messages.data.map((message: V2MessageInfo) => toV1MessageEntry(message)) };
      },
      revert: async (request: { readonly sessionID: string; readonly messageID?: string }) => {
        if (request.messageID) {
          await client.session.revert.stage({
            sessionID: request.sessionID,
            messageID: request.messageID,
            files: true,
          });
          await client.session.revert.commit({ sessionID: request.sessionID });
        }
        return { data: true };
      },
    },
    permission: {
      reply: async (request: {
        readonly requestID: string;
        readonly reply: "once" | "always" | "reject";
      }) => {
        const sessionID = permissionSessions.get(request.requestID);
        if (!sessionID) {
          throw new Error(`OpenCode V2 permission request '${request.requestID}' has no session.`);
        }
        await client.permission.reply({ ...request, sessionID });
        permissionSessions.delete(request.requestID);
        return { data: true };
      },
    },
    question: {
      reply: async (request: {
        readonly requestID: string;
        readonly answers: ReadonlyArray<ReadonlyArray<string>>;
      }) => {
        const sessionID = questionSessions.get(request.requestID);
        if (!sessionID) {
          throw new Error(`OpenCode V2 question request '${request.requestID}' has no session.`);
        }
        await client.question.reply({ ...request, sessionID });
        questionSessions.delete(request.requestID);
        return { data: true };
      },
    },
  };

  return compatibilityClient as unknown as OpenCodeV1Client;
}
