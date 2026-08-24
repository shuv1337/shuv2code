// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off

import * as NodeHttp from "node:http";

import type {
  OpenCodeV2DynamicToolCall,
  OpenCodeV2DynamicToolDefinition,
  OpenCodeV2DynamicToolReply,
  OpenCodeV2Event,
  OpenCodeV2SessionInfo,
} from "./opencodeV2Client.ts";
import { findProviderDynamicToolCatalogIssue } from "./Services/ProviderDynamicTools.ts";

export interface OpenCodeV2MockRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

export interface OpenCodeV2MockPrompt {
  readonly sessionID: string;
  readonly body: unknown;
}

export interface OpenCodeV2MockFormAnswer {
  readonly sessionID: string;
  readonly formID: string;
  readonly answer: Record<string, unknown>;
}

export interface OpenCodeV2MockToolReply {
  readonly sessionID: string;
  readonly callID: string;
  readonly reply: OpenCodeV2DynamicToolReply;
}

export interface OpenCodeV2Mock {
  readonly baseUrl: string;
  readonly sessions: Map<string, OpenCodeV2SessionInfo>;
  readonly sessionTools: Map<string, ReadonlyArray<OpenCodeV2DynamicToolDefinition>>;
  readonly prompts: OpenCodeV2MockPrompt[];
  readonly formAnswers: OpenCodeV2MockFormAnswer[];
  readonly toolReplies: OpenCodeV2MockToolReply[];
  readonly requests: OpenCodeV2MockRequest[];
  readonly events: OpenCodeV2Event[];
  readonly subscriberCount: number;
  readonly waitForSubscriber: (timeoutMs?: number) => Promise<void>;
  readonly triggerScript: (sessionID: string) => void;
  readonly triggerDynamicToolCall: (
    sessionID: string,
    call: { readonly callID: string; readonly tool: string; readonly input?: unknown },
  ) => void;
  readonly cancelDynamicToolCall: (sessionID: string, callID: string) => void;
  readonly close: () => Promise<void>;
}

const formID = "frm_mock_1";

function mockForm(sessionID: string) {
  return {
    id: formID,
    sessionID,
    title: "Mock questions",
    fields: [
      {
        key: "scope",
        type: "string",
        title: "Scope",
        description: "Choose a scope or enter another value.",
        options: [{ value: "small", label: "Small change" }],
      },
      {
        key: "custom",
        type: "string",
        title: "Custom detail",
        description: "Enter a custom detail.",
        options: [],
      },
    ],
  } as const;
}

async function readJson(request: NodeHttp.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const encoded = Buffer.concat(chunks).toString("utf8");
  return encoded.length > 0 ? (JSON.parse(encoded) as unknown) : undefined;
}

function sendJson(response: NodeHttp.ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startOpenCodeV2Mock(
  options: { readonly port?: number } = {},
): Promise<OpenCodeV2Mock> {
  const sessions = new Map<string, OpenCodeV2SessionInfo>();
  const sessionTools = new Map<string, ReadonlyArray<OpenCodeV2DynamicToolDefinition>>();
  const pendingToolCalls = new Map<string, Map<string, OpenCodeV2DynamicToolCall>>();
  const settledToolCallIds = new Set<string>();
  const toolReplies: OpenCodeV2MockToolReply[] = [];
  const prompts: OpenCodeV2MockPrompt[] = [];
  const formAnswers: OpenCodeV2MockFormAnswer[] = [];
  const requests: OpenCodeV2MockRequest[] = [];
  const events: OpenCodeV2Event[] = [];
  const subscribers = new Set<NodeHttp.ServerResponse>();
  const queuedEvents: OpenCodeV2Event[] = [];
  const scriptedSessions = new Set<string>();
  const subscriberWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (cause: Error) => void;
  }>();
  let nextSession = 1;
  let nextEvent = 1;
  let closed = false;

  const writeEvent = (response: NodeHttp.ServerResponse, event: OpenCodeV2Event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const emit = (event: Omit<OpenCodeV2Event, "id" | "created">) => {
    const envelope: OpenCodeV2Event = {
      id: `evt_mock_${nextEvent}`,
      created: 1_800_000_000_000 + nextEvent,
      ...event,
    };
    nextEvent += 1;
    events.push(envelope);
    if (subscribers.size === 0) {
      queuedEvents.push(envelope);
      return;
    }
    for (const subscriber of subscribers) writeEvent(subscriber, envelope);
  };
  const triggerScript = (sessionID: string) => {
    if (scriptedSessions.has(sessionID)) return;
    scriptedSessions.add(sessionID);
    const text = "Mock response";
    const commonTextData = {
      sessionID,
      assistantMessageID: "msg_mock_1",
      ordinal: 0,
    };
    emit({ type: "session.execution.started", data: { sessionID } });
    emit({ type: "session.text.started", data: commonTextData });
    emit({ type: "session.text.delta", data: { ...commonTextData, delta: text } });
    emit({ type: "session.text.ended", data: { ...commonTextData, text } });
    emit({
      type: "session.tool.input.started",
      data: {
        sessionID,
        assistantMessageID: "msg_mock_1",
        id: "call_mock_1",
        name: "bash",
      },
    });
    emit({
      type: "session.tool.success",
      data: {
        sessionID,
        assistantMessageID: "msg_mock_1",
        id: "call_mock_1",
        name: "bash",
        output: "mock output",
      },
    });
    emit({ type: "form.created", data: { form: mockForm(sessionID) } });
  };
  const triggerDynamicToolCall = (
    sessionID: string,
    call: { readonly callID: string; readonly tool: string; readonly input?: unknown },
  ) => {
    const pending = pendingToolCalls.get(sessionID) ?? new Map<string, OpenCodeV2DynamicToolCall>();
    pendingToolCalls.set(sessionID, pending);
    pending.set(call.callID, {
      callID: call.callID,
      sessionID,
      tool: call.tool,
      input: call.input,
      time: { requested: 1_800_000_000_000 },
    });
    emit({
      type: "session.tool.dynamic.requested",
      data: { sessionID, callID: call.callID, tool: call.tool, input: call.input },
    });
  };
  const cancelDynamicToolCall = (sessionID: string, callID: string) => {
    pendingToolCalls.get(sessionID)?.delete(callID);
    emit({ type: "session.tool.dynamic.cancelled", data: { sessionID, callID } });
  };

  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (method === "GET" && path === "/api/event") {
        requests.push({ method, path });
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        response.write(": connected\n\n");
        subscribers.add(response);
        emit({ type: "server.connected", data: {} });
        for (const waiter of subscriberWaiters) waiter.resolve();
        subscriberWaiters.clear();
        for (const event of queuedEvents.splice(0)) writeEvent(response, event);
        request.once("close", () => subscribers.delete(response));
        return;
      }

      const body = method === "POST" || method === "PUT" ? await readJson(request) : undefined;
      requests.push({ method, path, ...(body === undefined ? {} : { body }) });

      if (method === "GET" && path === "/api/health") {
        sendJson(response, { healthy: true, version: "2.0.0-mock", pid: process.pid });
        return;
      }
      if (method === "POST" && path === "/api/session") {
        const input = (body ?? {}) as {
          readonly title?: string;
          readonly location?: { readonly directory?: string };
          readonly metadata?: Readonly<Record<string, unknown>>;
          readonly tools?: ReadonlyArray<OpenCodeV2DynamicToolDefinition>;
        };
        const toolIssue = findProviderDynamicToolCatalogIssue(input.tools ?? []);
        if (toolIssue !== null) {
          sendJson(response, { name: "InvalidRequestError", message: toolIssue }, 400);
          return;
        }
        const session: OpenCodeV2SessionInfo = {
          id: `ses_mock_${nextSession}`,
          ...(input.title ? { title: input.title } : {}),
          ...(input.location ? { location: input.location } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
        nextSession += 1;
        sessions.set(session.id, session);
        if (input.tools !== undefined) sessionTools.set(session.id, input.tools);
        sendJson(response, { data: session }, 201);
        return;
      }

      const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
      if (segments[0] === "api" && segments[1] === "session" && segments[2]) {
        const sessionID = segments[2];
        const suffix = segments.slice(3);
        const session = sessions.get(sessionID);
        if (!session) {
          sendJson(response, { error: "session not found" }, 404);
          return;
        }
        if (method === "GET" && suffix.length === 0) {
          sendJson(response, { data: session });
          return;
        }
        if (method === "GET" && suffix[0] === "message") {
          sendJson(response, { data: [], cursor: {} });
          return;
        }
        if (method === "POST" && suffix[0] === "prompt") {
          prompts.push({ sessionID, body });
          triggerScript(sessionID);
          sendJson(response, { data: { id: "prompt_mock_1" } }, 202);
          return;
        }
        if (method === "GET" && suffix[0] === "form") {
          sendJson(response, {
            data: scriptedSessions.has(sessionID) ? [mockForm(sessionID)] : [],
          });
          return;
        }
        if (method === "POST" && suffix[0] === "form" && suffix[1] && suffix[2] === "reply") {
          const input = body as { readonly answer?: Record<string, unknown> } | undefined;
          const answer = input?.answer ?? {};
          formAnswers.push({ sessionID, formID: suffix[1], answer });
          emit({ type: "form.replied", data: { sessionID, id: suffix[1], answer } });
          emit({ type: "session.execution.succeeded", data: { sessionID } });
          response.writeHead(204).end();
          return;
        }
        if (method === "GET" && suffix[0] === "permission") {
          sendJson(response, { data: [] });
          return;
        }
        if (method === "PUT" && suffix[0] === "tools" && suffix.length === 1) {
          const input = (body ?? {}) as {
            readonly tools?: ReadonlyArray<OpenCodeV2DynamicToolDefinition>;
          };
          const toolIssue = findProviderDynamicToolCatalogIssue(input.tools ?? []);
          if (toolIssue !== null) {
            sendJson(response, { name: "InvalidRequestError", message: toolIssue }, 400);
            return;
          }
          sessionTools.set(sessionID, input.tools ?? []);
          emit({
            type: "session.tool.dynamic.updated",
            data: { sessionID, tools: input.tools ?? [] },
          });
          response.writeHead(204).end();
          return;
        }
        if (method === "GET" && suffix[0] === "tools" && suffix.length === 1) {
          sendJson(response, { data: sessionTools.get(sessionID) ?? [] });
          return;
        }
        if (method === "GET" && suffix[0] === "tools" && suffix[1] === "calls") {
          sendJson(response, { data: [...(pendingToolCalls.get(sessionID)?.values() ?? [])] });
          return;
        }
        if (
          method === "POST" &&
          suffix[0] === "tools" &&
          suffix[1] === "calls" &&
          suffix[2] &&
          suffix[3] === "reply"
        ) {
          const callID = suffix[2];
          const pending = pendingToolCalls.get(sessionID);
          if (!pending?.has(callID)) {
            sendJson(
              response,
              { name: "ConflictError", message: `Dynamic tool call not pending: ${callID}` },
              409,
            );
            return;
          }
          pending.delete(callID);
          settledToolCallIds.add(callID);
          toolReplies.push({ sessionID, callID, reply: body as OpenCodeV2DynamicToolReply });
          emit({ type: "session.tool.dynamic.replied", data: { sessionID, callID } });
          response.writeHead(204).end();
          return;
        }
      }

      if (method === "GET" && path === "/api/model") {
        sendJson(response, {
          data: [
            {
              id: "mock-model",
              providerID: "mock",
              name: "Mock Model",
              enabled: true,
              variants: [],
            },
          ],
        });
        return;
      }
      if (method === "GET" && path === "/api/agent") {
        sendJson(response, {
          data: [{ id: "build", mode: "primary", hidden: false }],
        });
        return;
      }
      if (method === "GET" && ["/api/provider", "/api/skill"].includes(path)) {
        sendJson(response, { data: [] });
        return;
      }
      sendJson(response, { error: "not found" }, 404);
    })().catch((cause: unknown) => {
      if (response.headersSent) {
        response.destroy(cause instanceof Error ? cause : undefined);
      } else {
        sendJson(response, { error: "mock request failed" }, 500);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.closeAllConnections();
    throw new Error("OpenCode V2 mock did not bind a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessions,
    sessionTools,
    prompts,
    formAnswers,
    toolReplies,
    requests,
    events,
    get subscriberCount() {
      return subscribers.size;
    },
    waitForSubscriber: (timeoutMs = 2_000) => {
      if (subscribers.size > 0) return Promise.resolve();
      if (closed) return Promise.reject(new Error("OpenCode V2 mock is closed."));
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const waiter = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (cause: Error) => {
            clearTimeout(timer);
            reject(cause);
          },
        };
        timer = setTimeout(() => {
          subscriberWaiters.delete(waiter);
          reject(new Error(`Timed out waiting ${timeoutMs}ms for an OpenCode V2 SSE subscriber.`));
        }, timeoutMs);
        subscriberWaiters.add(waiter);
      });
    },
    triggerScript,
    triggerDynamicToolCall,
    cancelDynamicToolCall,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const waiter of subscriberWaiters) {
        waiter.reject(new Error("OpenCode V2 mock closed before an SSE subscriber connected."));
      }
      subscriberWaiters.clear();
      for (const subscriber of subscribers) subscriber.end();
      subscribers.clear();
      const closing = new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      });
      server.closeAllConnections();
      await closing;
    },
  };
}
