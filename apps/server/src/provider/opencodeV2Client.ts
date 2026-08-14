// @effect-diagnostics nodeBuiltinImport:off

import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStringDecoder from "node:string_decoder";

import { basicAuthHeader } from "./opencodeShared.ts";

export interface OpenCodeV2BufferLimits {
  readonly responseBodyBytes: number;
  readonly sseEventBytes: number;
}

export const OPEN_CODE_V2_CLIENT_BUFFER_LIMITS: OpenCodeV2BufferLimits = {
  responseBodyBytes: 64 * 1024 * 1024,
  sseEventBytes: 16 * 1024 * 1024,
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

export interface OpenCodeV2Event {
  readonly id?: string;
  readonly type: string;
  readonly created?: number;
  readonly data?: unknown;
  readonly location?: unknown;
  readonly metadata?: unknown;
  readonly durable?: unknown;
}

export interface OpenCodeV2SessionInfo {
  readonly id: string;
  readonly title?: string;
  readonly location?: { readonly directory?: string };
}

export interface OpenCodeV2ProjectedMessages {
  readonly data?: ReadonlyArray<unknown>;
  readonly items?: ReadonlyArray<unknown>;
  readonly cursor?: {
    readonly previous?: string;
    readonly next?: string;
  };
}

export interface OpenCodeV2ClientInput {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly bufferLimits?: Partial<OpenCodeV2BufferLimits>;
}

function resolveBufferLimits(
  overrides: Partial<OpenCodeV2BufferLimits> | undefined,
): OpenCodeV2BufferLimits {
  const resolve = (name: keyof OpenCodeV2BufferLimits): number => {
    const value = overrides?.[name] ?? OPEN_CODE_V2_CLIENT_BUFFER_LIMITS[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`OpenCode V2 ${name} must be a positive safe integer.`);
    }
    return value;
  };
  return {
    responseBodyBytes: resolve("responseBodyBytes"),
    sseEventBytes: resolve("sseEventBytes"),
  };
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

export function createOpenCodeV2Client(input: OpenCodeV2ClientInput) {
  const bufferLimits = resolveBufferLimits(input.bufferLimits);
  const headers = input.serverPassword
    ? { Authorization: basicAuthHeader(input.serverPassword) }
    : undefined;
  const location = { directory: input.directory };

  const request = async <A>(
    method: string,
    path: string,
    options?: {
      readonly query?: Record<string, unknown>;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly empty?: boolean;
    },
  ): Promise<A> => {
    const url = new URL(path, input.baseUrl);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      appendQuery(url.searchParams, key, value);
    }
    const encodedBody = options?.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await openHttpRequest({
      url,
      method,
      ...(options?.signal ? { signal: options.signal } : {}),
      headers: {
        ...headers,
        ...(options?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(encodedBody === undefined ? {} : { body: encodedBody }),
    });
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      const encoded = await readResponseBody(response, {
        maximumBytes: bufferLimits.responseBodyBytes,
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
    if (options?.empty || status === 204) {
      response.destroy();
      return undefined as A;
    }
    return JSON.parse(
      await readResponseBody(response, {
        maximumBytes: bufferLimits.responseBodyBytes,
        resource: url.pathname,
      }),
    ) as A;
  };

  const data = async <A>(
    method: string,
    path: string,
    options?: Parameters<typeof request>[2],
  ): Promise<A> => {
    const response = await request<{ readonly data: A }>(method, path, options);
    return response.data;
  };

  const eventSubscribe = (signal?: AbortSignal): AsyncIterable<OpenCodeV2Event> => ({
    async *[Symbol.asyncIterator]() {
      const response = await openHttpRequest({
        url: new URL("/api/event", input.baseUrl),
        method: "GET",
        ...(signal ? { signal } : {}),
        ...(headers ? { headers } : {}),
      });
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new Error(`OpenCode V2 event subscription failed with status ${status}.`);
      }
      let buffer = "";
      let pendingCarriageReturn = false;
      const decoder = new NodeStringDecoder.StringDecoder("utf8");
      const assertEventSize = (encoded: string, includesPendingCarriageReturn = false) => {
        const receivedBytes =
          Buffer.byteLength(encoded, "utf8") + (includesPendingCarriageReturn ? 1 : 0);
        if (receivedBytes > bufferLimits.sseEventBytes) {
          throw new OpenCodeV2EventTooLargeError({
            maximumBytes: bufferLimits.sseEventBytes,
            receivedBytes,
          });
        }
      };
      const appendDecoded = (decoded: string, final = false) => {
        let available = decoded;
        if (pendingCarriageReturn) {
          if (available.length === 0 && !final) {
            return;
          }
          buffer += "\n";
          if (available.startsWith("\n")) available = available.slice(1);
          pendingCarriageReturn = false;
        }
        if (!final && available.endsWith("\r")) {
          available = available.slice(0, -1);
          pendingCarriageReturn = true;
        }
        buffer += available.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      };
      const parseAvailableEvents = function* () {
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
            yield JSON.parse(encoded) as OpenCodeV2Event;
          }
          boundary = buffer.indexOf("\n\n");
        }
        assertEventSize(buffer, pendingCarriageReturn);
      };
      try {
        for await (const chunk of response) {
          appendDecoded(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          yield* parseAvailableEvents();
        }
        appendDecoded(decoder.end(), true);
        yield* parseAvailableEvents();
      } finally {
        response.destroy();
      }
    },
  });

  const sessionPath = (sessionID: string, suffix = "") =>
    `/api/session/${encodeURIComponent(sessionID)}${suffix}`;

  return {
    event: {
      subscribe: (options?: { readonly signal?: AbortSignal }) => eventSubscribe(options?.signal),
    },
    session: {
      create: (body?: {
        readonly title?: string;
        readonly location?: { readonly directory: string };
        readonly agent?: string;
        readonly model?: unknown;
      }) =>
        data<OpenCodeV2SessionInfo>("POST", "/api/session", {
          body: {
            location,
            ...body,
          },
        }),
      get: (sessionID: string) => data<OpenCodeV2SessionInfo>("GET", sessionPath(sessionID)),
      messages: (sessionID: string, options?: { readonly cursor?: string }) =>
        request<OpenCodeV2ProjectedMessages>("GET", sessionPath(sessionID, "/message"), {
          query: {
            directory: input.directory,
            ...(options?.cursor ? { cursor: options.cursor } : {}),
          },
        }),
      fork: (
        sessionID: string,
        body: {
          readonly boundary:
            | { readonly type: "through" }
            | { readonly type: "before"; readonly messageID: string };
        },
      ) => data<OpenCodeV2SessionInfo>("POST", sessionPath(sessionID, "/fork"), { body }),
      prompt: (
        sessionID: string,
        body: {
          readonly text: string;
          readonly files?: ReadonlyArray<{ readonly uri: string; readonly name?: string }>;
          readonly agent?: string;
        },
      ) => data<unknown>("POST", sessionPath(sessionID, "/prompt"), { body }),
      interrupt: (sessionID: string) =>
        request<void>("POST", sessionPath(sessionID, "/interrupt"), { empty: true }),
      wait: (sessionID: string) =>
        request<void>("POST", sessionPath(sessionID, "/wait"), { empty: true }),
      active: () => data<Record<string, { readonly type?: string }>>("GET", "/api/session/active"),
      rename: (sessionID: string, title: string) =>
        request<void>("POST", sessionPath(sessionID, "/rename"), {
          body: { title },
          empty: true,
        }),
    },
    form: {
      list: (sessionID: string) =>
        data<ReadonlyArray<unknown>>("GET", sessionPath(sessionID, "/form")),
      reply: (sessionID: string, formID: string, answer: Record<string, unknown>) =>
        request<void>("POST", sessionPath(sessionID, `/form/${encodeURIComponent(formID)}/reply`), {
          body: { answer },
          empty: true,
        }),
      cancel: (sessionID: string, formID: string) =>
        request<void>(
          "POST",
          sessionPath(sessionID, `/form/${encodeURIComponent(formID)}/cancel`),
          {
            empty: true,
          },
        ),
    },
    permission: {
      list: (sessionID: string) =>
        data<ReadonlyArray<unknown>>("GET", sessionPath(sessionID, "/permission")),
      reply: (
        sessionID: string,
        requestID: string,
        reply: "once" | "always" | "reject",
        message?: string,
      ) =>
        request<void>(
          "POST",
          sessionPath(sessionID, `/permission/${encodeURIComponent(requestID)}/reply`),
          {
            body: { reply, ...(message ? { message } : {}) },
            empty: true,
          },
        ),
    },
    provider: {
      list: () =>
        request<{ data: ReadonlyArray<unknown> }>("GET", "/api/provider", {
          query: { location },
        }),
    },
    model: {
      list: () =>
        request<{ data: ReadonlyArray<unknown> }>("GET", "/api/model", {
          query: { location },
        }),
    },
    agent: {
      list: () =>
        request<{ data: ReadonlyArray<unknown> }>("GET", "/api/agent", {
          query: { location },
        }),
    },
    skill: {
      list: () =>
        request<{ data: ReadonlyArray<unknown> }>("GET", "/api/skill", {
          query: { location },
        }),
    },
  };
}

export type OpenCodeV2Client = ReturnType<typeof createOpenCodeV2Client>;
