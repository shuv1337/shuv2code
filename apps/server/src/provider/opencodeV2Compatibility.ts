// @effect-diagnostics nodeBuiltinImport:off

import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

import type {
  Agent as OpenCodeV1Agent,
  OpencodeClient as OpenCodeV1Client,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2";

interface V2CompatibilityClientInput {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
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
  readonly variants: ReadonlyArray<{ readonly id: string }>;
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

async function readResponseBody(response: NodeHttp.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function makeOpenCodeV2Client(options: {
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
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
      const encoded = await readResponseBody(response);
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
    return JSON.parse(await readResponseBody(response)) as A;
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
      try {
        for await (const chunk of response) {
          buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const encoded = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n");
            if (encoded.length > 0) {
              yield JSON.parse(encoded) as { type: string; data?: unknown };
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
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
        reasoning: model.variants.length > 0,
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

function normalizeEvent(event: { readonly type: string; readonly data?: unknown }) {
  return {
    type: event.type,
    properties: event.data ?? {},
  };
}

/**
 * Adapts the OpenCode V2 client to the subset of the V1 SDK surface consumed by
 * T3 Code. Keeping this boundary in one place lets the existing event projection
 * and provider adapter continue to serve both protocol generations.
 */
export function createOpenCodeV2CompatibilityClient(
  input: V2CompatibilityClientInput,
): OpenCodeV1Client {
  const client = makeOpenCodeV2Client({
    baseUrl: input.baseUrl,
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
    },
    event: {
      subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => {
        const source = client.event.subscribe(
          options?.signal ? { signal: options.signal } : undefined,
        );
        async function* stream() {
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
              permissionSessions.set(eventData.id, eventData.sessionID);
            }
            if (
              (event.type === "question.v2.asked" || event.type === "question.asked") &&
              typeof eventData?.id === "string" &&
              typeof eventData.sessionID === "string"
            ) {
              questionSessions.set(eventData.id, eventData.sessionID);
            }
            yield normalizeEvent(event);
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
      // V2 has no per-session permission-ruleset update. T3 still calls this
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
        return { data: true };
      },
    },
  };

  return compatibilityClient as unknown as OpenCodeV1Client;
}
