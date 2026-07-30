// @effect-diagnostics nodeBuiltinImport:off

import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";

import { afterEach, describe, it } from "vite-plus/test";

import {
  createOpenCodeV2CompatibilityClient,
  OpenCodeV2EventTooLargeError,
  OpenCodeV2ResponseBodyTooLargeError,
  OpenCodeV2StreamStateOverflowError,
} from "./opencodeV2Compatibility.ts";

describe("createOpenCodeV2CompatibilityClient", () => {
  const servers: NodeHttp.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function listen(
    handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void | Promise<void>,
  ): Promise<string> {
    const server = NodeHttp.createServer((req, res) => {
      void Promise.resolve(handler(req, res)).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp address");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async function readBody(req: NodeHttp.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function textPartRetainedBytes(input: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly kind?: "text" | "reasoning";
    readonly ordinal?: number;
  }): number {
    const kind = input.kind ?? "text";
    const ordinal = input.ordinal ?? 0;
    const key = `${input.sessionID}:${input.messageID}:${kind}:${ordinal}`;
    const partID = `prt_${input.messageID.replace(/^msg_?/, "")}_${kind}_${ordinal}`;
    return Buffer.byteLength(key) + Buffer.byteLength(partID) + Buffer.byteLength(input.sessionID);
  }

  function toolPartRetainedBytes(input: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly callID: string;
    readonly name: string;
  }): number {
    const key = `${input.sessionID}:${input.messageID}:tool:${input.callID}`;
    const partID = `prt_${input.messageID.replace(/^msg_?/, "")}_tool_${input.callID}`;
    return [key, partID, input.sessionID, input.messageID, input.callID, input.name].reduce(
      (bytes, value) => bytes + Buffer.byteLength(value),
      0,
    );
  }

  it("rejects disabled or unbounded buffer ceilings", () => {
    NodeAssert.throws(
      () =>
        createOpenCodeV2CompatibilityClient({
          baseUrl: "http://127.0.0.1",
          directory: "/tmp/project",
          bufferLimits: { sseEventBytes: Number.POSITIVE_INFINITY },
        }),
      /sseEventBytes must be a positive safe integer/,
    );
  });

  it("sends basic auth and flattens provider/model inventory", async () => {
    const expectedAuth = `Basic ${Buffer.from("opencode:pw", "utf8").toString("base64")}`;
    const baseUrl = await listen(async (req, res) => {
      NodeAssert.equal(req.headers.authorization, expectedAuth);
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/provider")) {
        res.end(
          JSON.stringify({
            data: [{ id: "openai", name: "OpenAI" }],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/api/model")) {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "gpt-5.4",
                providerID: "openai",
                name: "GPT-5.4",
                enabled: true,
                status: "active",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                variants: [{ id: "medium" }],
                time: { released: 1 },
                limit: { context: 100, output: 50 },
              },
              {
                id: "gpt-5.4-mini",
                providerID: "openai",
                name: "GPT-5.4 mini",
                enabled: true,
                status: "active",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                time: { released: 1 },
                limit: { context: 100, output: 50 },
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      serverPassword: "pw",
    });
    const list = await client.provider.list();
    NodeAssert.ok(list.data);
    NodeAssert.deepEqual(list.data.connected, ["openai"]);
    NodeAssert.equal(list.data.all[0]?.models["gpt-5.4"]?.name, "GPT-5.4");
    NodeAssert.equal(list.data.all[0]?.models["gpt-5.4-mini"]?.capabilities.reasoning, false);
  });

  it("uses stable agent ids for selection, not display names", async () => {
    const baseUrl = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/agent")) {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "build",
                name: "Build",
                mode: "primary",
                hidden: false,
                description: "default",
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
    });
    const agents = await client.app.agents();
    NodeAssert.equal(agents.data?.[0]?.name, "build");
  });

  it("lists skills for the configured V2 location through the legacy app surface", async () => {
    const baseUrl = await listen((req, res) => {
      const url = new URL(req.url ?? "", "http://localhost");
      NodeAssert.equal(url.pathname, "/api/skill");
      NodeAssert.equal(url.searchParams.get("location[directory]"), "/tmp/project");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          location: { directory: "/tmp/project", project: { id: "project", directory: "/tmp" } },
          data: [
            {
              id: "review",
              name: "review",
              description: "Review the current changes",
              location: "/tmp/project/.opencode/skills/review/SKILL.md",
              content: "Review carefully.",
            },
          ],
        }),
      );
    });

    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
    });
    const skills = await client.app.skills();

    NodeAssert.deepEqual(skills.data, [
      {
        id: "review",
        name: "review",
        description: "Review the current changes",
        location: "/tmp/project/.opencode/skills/review/SKILL.md",
        content: "Review carefully.",
      },
    ]);
  });

  it("normalizes event data into legacy properties and tracks permission sessions", async () => {
    const baseUrl = await listen((req, res) => {
      if (req.url === "/api/event") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({
            type: "permission.asked",
            data: { id: "perm-1", sessionID: "ses_1", permission: "bash" },
          })}\n\n`,
        );
        res.end();
        return;
      }
      if (req.method === "POST" && req.url === "/api/session/ses_1/permission/perm-1/reply") {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
    });
    const subscription = await client.event.subscribe();
    const events: Array<{ type: string; properties: unknown }> = [];
    for await (const event of subscription.stream) {
      events.push(event as { type: string; properties: unknown });
      break;
    }
    NodeAssert.equal(events[0]?.type, "permission.asked");
    NodeAssert.deepEqual(events[0]?.properties, {
      id: "perm-1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: [],
    });
    await client.permission.reply({ requestID: "perm-1", reply: "once" });
    await NodeAssert.rejects(
      client.permission.reply({ requestID: "perm-1", reply: "once" }),
      /has no session/,
    );
  });

  it("normalizes V2 question events and routes replies to their owning session", async () => {
    let replyBody: unknown;
    const baseUrl = await listen(async (req, res) => {
      if (req.url === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            type: "question.v2.asked",
            data: {
              id: "que_1",
              sessionID: "ses_1",
              questions: [
                {
                  header: "Repository access",
                  question: "Which repositories should the token access?",
                  options: [
                    { label: "Selected", description: "Only selected repositories" },
                    { label: "All", description: "All current repositories" },
                  ],
                  multiple: false,
                  custom: true,
                },
              ],
            },
          })}\n\n`,
        );
        res.end();
        return;
      }
      if (req.method === "POST" && req.url === "/api/session/ses_1/question/que_1/reply") {
        replyBody = JSON.parse(await readBody(req));
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
    });
    const subscription = await client.event.subscribe();
    const events: Array<{ type: string; properties: unknown }> = [];
    for await (const event of subscription.stream) {
      events.push(event as { type: string; properties: unknown });
    }

    NodeAssert.equal(events[0]?.type, "question.asked");
    NodeAssert.deepEqual(events[0]?.properties, {
      id: "que_1",
      sessionID: "ses_1",
      questions: [
        {
          header: "Repository access",
          question: "Which repositories should the token access?",
          options: [
            { label: "Selected", description: "Only selected repositories" },
            { label: "All", description: "All current repositories" },
          ],
          multiple: false,
          custom: true,
        },
      ],
    });

    await client.question.reply({ requestID: "que_1", answers: [["Selected"]] });
    NodeAssert.deepEqual(replyBody, { answers: [["Selected"]] });
    await NodeAssert.rejects(
      client.question.reply({ requestID: "que_1", answers: [["Selected"]] }),
      /has no session/,
    );
  });

  it("releases remote replied and rejected question correlations", async () => {
    const nativeEvents = [
      {
        type: "question.v2.asked",
        data: { id: "que_1", sessionID: "ses_1", questions: [] },
      },
      {
        type: "question.v2.replied",
        data: { requestID: "que_1", sessionID: "ses_1", answers: [[]] },
      },
      {
        type: "question.v2.asked",
        data: { id: "que_2", sessionID: "ses_1", questions: [] },
      },
      {
        type: "question.v2.rejected",
        data: { id: "que_2", sessionID: "ses_1" },
      },
      {
        type: "question.v2.asked",
        data: { id: "que_3", sessionID: "ses_1", questions: [] },
      },
    ];
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of nativeEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { activeStreamParts: 1 },
    });
    const subscription = await client.event.subscribe();
    const events: Array<{ readonly type: string }> = [];
    for await (const event of subscription.stream) events.push(event);

    NodeAssert.deepEqual(
      events.map((event) => event.type),
      [
        "question.asked",
        "question.replied",
        "question.asked",
        "question.rejected",
        "question.asked",
      ],
    );
  });

  it("budgets correlation identifiers and stream parts under one shared ceiling", async () => {
    const requestID = "permission-request";
    const sessionID = "session-owner";
    const permissionEvent = {
      type: "permission.asked",
      data: { id: requestID, sessionID, permission: "bash" },
    };
    const textEvent = {
      type: "session.text.started",
      data: { sessionID, assistantMessageID: "msg_after_permission", ordinal: 0 },
    };
    let requestNumber = 0;
    const baseUrl = await listen((_req, res) => {
      requestNumber += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requestNumber <= 2) {
        res.end(`data: ${JSON.stringify(permissionEvent)}\n\n`);
        return;
      }
      res.write(`data: ${JSON.stringify(permissionEvent)}\n\n`);
      res.end(`data: ${JSON.stringify(textEvent)}\n\n`);
    });
    const correlationBytes = Buffer.byteLength(requestID) + Buffer.byteLength(sessionID);
    const consumePermission = async (streamStateBytes: number) => {
      const client = createOpenCodeV2CompatibilityClient({
        baseUrl,
        directory: "/tmp/project",
        bufferLimits: { streamStateBytes },
      });
      const subscription = await client.event.subscribe();
      for await (const _event of subscription.stream) {
        // Consume the full subscription.
      }
    };

    await consumePermission(correlationBytes);
    await NodeAssert.rejects(consumePermission(correlationBytes - 1), (cause: unknown) => {
      NodeAssert.ok(cause instanceof OpenCodeV2StreamStateOverflowError);
      NodeAssert.equal(cause.retainedBytes, correlationBytes);
      return true;
    });

    const sharedBudgetClient = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { activeStreamParts: 1 },
    });
    const sharedSubscription = await sharedBudgetClient.event.subscribe();
    await NodeAssert.rejects(
      async () => {
        for await (const _event of sharedSubscription.stream) {
          // The text part is the second active retained entry.
        }
      },
      (cause: unknown) => {
        NodeAssert.ok(cause instanceof OpenCodeV2StreamStateOverflowError);
        NodeAssert.equal(cause.maximumActiveParts, 1);
        NodeAssert.equal(cause.activeParts, 2);
        return true;
      },
    );
  });

  it("rejects a declared oversized HTTP response before retaining its body", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": "65",
      });
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { responseBodyBytes: 64 },
    });

    await NodeAssert.rejects(client.app.skills(), (cause: unknown) => {
      NodeAssert.ok(cause instanceof OpenCodeV2ResponseBodyTooLargeError);
      NodeAssert.equal(cause.maximumBytes, 64);
      NodeAssert.equal(cause.receivedBytes, 65);
      NodeAssert.equal(cause.resource, "/api/skill");
      return true;
    });
  });

  it("accepts an HTTP response exactly at the configured byte ceiling", async () => {
    const encoded = JSON.stringify({ data: [] });
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(encoded)),
      });
      res.end(encoded);
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { responseBodyBytes: Buffer.byteLength(encoded) },
    });

    const skills = await client.app.skills();
    NodeAssert.deepEqual(skills.data, []);
  });

  it("bounds a chunked HTTP response even when content-length is absent", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("x".repeat(40));
      res.end("x".repeat(40));
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { responseBodyBytes: 64 },
    });

    await NodeAssert.rejects(client.app.skills(), (cause: unknown) => {
      NodeAssert.ok(cause instanceof OpenCodeV2ResponseBodyTooLargeError);
      NodeAssert.equal(cause.maximumBytes, 64);
      NodeAssert.ok(cause.receivedBytes > 64);
      NodeAssert.ok(cause.receivedBytes <= 80);
      return true;
    });
  });

  it("destroys a rejected SSE response instead of leaving its body open", async () => {
    let resolveClosed!: () => void;
    const responseClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const baseUrl = await listen((req, res) => {
      NodeAssert.equal(req.url, "/api/event");
      res.once("close", resolveClosed);
      res.writeHead(503, { "content-type": "text/event-stream" });
      res.write("data: still-streaming");
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
    });
    const subscription = await client.event.subscribe();

    await NodeAssert.rejects(async () => {
      for await (const _event of subscription.stream) {
        // A rejected subscription must fail before yielding.
      }
    }, /event subscription failed with status 503/);
    await responseClosed;
  });

  it("accepts an SSE event exactly at the configured byte ceiling", async () => {
    const block = `data: ${JSON.stringify({
      type: "session.execution.started",
      data: { sessionID: "ses_exact" },
    })}`;
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${block}\n\n`);
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { sseEventBytes: Buffer.byteLength(block) },
    });
    const subscription = await client.event.subscribe();
    const events = [];
    for await (const event of subscription.stream) events.push(event);

    NodeAssert.equal(events[0]?.type, "session.status");
    NodeAssert.deepEqual(events[0]?.properties.status, { type: "busy" });
  });

  it("bounds an SSE event that never supplies a delimiter", async () => {
    const baseUrl = await listen((req, res) => {
      NodeAssert.equal(req.url, "/api/event");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${"x".repeat(40)}`);
      res.end("x".repeat(40));
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { sseEventBytes: 64 },
    });
    const subscription = await client.event.subscribe();

    await NodeAssert.rejects(
      async () => {
        for await (const _event of subscription.stream) {
          // The oversized event must fail before yielding.
        }
      },
      (cause: unknown) => {
        NodeAssert.ok(cause instanceof OpenCodeV2EventTooLargeError);
        NodeAssert.equal(cause.maximumBytes, 64);
        NodeAssert.ok(cause.receivedBytes > 64);
        return true;
      },
    );
  });

  it("preserves a valid UTF-8 SSE event split across byte boundaries", async () => {
    const nativeEvent = {
      type: "session.text.delta",
      created: 2,
      data: {
        sessionID: "ses_utf8",
        assistantMessageID: "msg_utf8",
        ordinal: 0,
        delta: "moon 🌕",
      },
    };
    const baseUrl = await listen((req, res) => {
      NodeAssert.equal(req.url, "/api/event");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const encoded = Buffer.from(`data: ${JSON.stringify(nativeEvent)}\n\n`, "utf8");
      for (const byte of encoded) res.write(Buffer.from([byte]));
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { sseEventBytes: 1_024 },
    });
    const subscription = await client.event.subscribe();
    const events = [];
    for await (const event of subscription.stream) events.push(event);

    const delta = events.find((event) => event.type === "message.part.delta");
    NodeAssert.equal(delta?.properties.delta, "moon 🌕");
    NodeAssert.equal(delta?.properties.sessionID, "ses_utf8");
  });

  it("preserves multiline CRLF events when every carriage-return pair is split", async () => {
    const nativeEvent = {
      type: "session.text.delta",
      created: 2,
      data: {
        sessionID: "ses_crlf",
        assistantMessageID: "msg_crlf",
        ordinal: 0,
        delta: "split safely",
      },
    };
    const serialized = JSON.stringify(nativeEvent);
    const secondLineOffset = serialized.indexOf('"created"');
    NodeAssert.ok(secondLineOffset > 0);
    const frame =
      `data: ${serialized.slice(0, secondLineOffset)}\r\n` +
      `data: ${serialized.slice(secondLineOffset)}\r\n\r\n`;
    const baseUrl = await listen((req, res) => {
      NodeAssert.equal(req.url, "/api/event");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const byte of Buffer.from(frame, "utf8")) res.write(Buffer.from([byte]));
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { sseEventBytes: 1_024 },
    });
    const subscription = await client.event.subscribe();
    const events = [];
    for await (const event of subscription.stream) events.push(event);

    const delta = events.find((event) => event.type === "message.part.delta");
    NodeAssert.equal(delta?.properties.delta, "split safely");
    NodeAssert.equal(delta?.properties.sessionID, "ses_crlf");
  });

  it("admits retained text identifiers exactly at the byte ceiling and rejects one byte below", async () => {
    const sessionID = "ses_budget";
    const messageID = "msg_budget";
    const nativeEvent = {
      type: "session.text.started",
      data: { sessionID, assistantMessageID: messageID, ordinal: 0 },
    };
    const retainedBytes = textPartRetainedBytes({ sessionID, messageID });
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(nativeEvent)}\n\n`);
    });
    const consume = async (streamStateBytes: number) => {
      const client = createOpenCodeV2CompatibilityClient({
        baseUrl,
        directory: "/tmp/project",
        bufferLimits: { sseEventBytes: 1_024, streamStateBytes },
      });
      const subscription = await client.event.subscribe();
      for await (const _event of subscription.stream) {
        // Consume the full subscription.
      }
    };

    await consume(retainedBytes);
    await NodeAssert.rejects(consume(retainedBytes - 1), (cause: unknown) => {
      NodeAssert.ok(cause instanceof OpenCodeV2StreamStateOverflowError);
      NodeAssert.equal(cause.maximumBytes, retainedBytes - 1);
      NodeAssert.equal(cause.retainedBytes, retainedBytes);
      return true;
    });
  });

  it("budgets retained tool identifiers, names, and normalized input together", async () => {
    const sessionID = "ses_tool";
    const messageID = "msg_tool";
    const callID = "call_tool";
    const initialName = "read";
    const finalName = "read-a-large-resource";
    const input = { path: "/tmp/resource", options: ["metadata", "content"] };
    const nativeEvents = [
      {
        type: "session.tool.input.started",
        data: { sessionID, assistantMessageID: messageID, callID, name: initialName },
      },
      {
        type: "session.tool.progress",
        data: {
          sessionID,
          assistantMessageID: messageID,
          callID,
          name: finalName,
          input,
        },
      },
    ];
    const retainedBytes =
      toolPartRetainedBytes({ sessionID, messageID, callID, name: finalName }) +
      Buffer.byteLength(JSON.stringify(input));
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of nativeEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const consume = async (streamStateBytes: number) => {
      const client = createOpenCodeV2CompatibilityClient({
        baseUrl,
        directory: "/tmp/project",
        bufferLimits: { sseEventBytes: 1_024, streamStateBytes },
      });
      const subscription = await client.event.subscribe();
      for await (const _event of subscription.stream) {
        // Consume the full subscription.
      }
    };

    await consume(retainedBytes);
    await NodeAssert.rejects(consume(retainedBytes - 1), (cause: unknown) => {
      NodeAssert.ok(cause instanceof OpenCodeV2StreamStateOverflowError);
      NodeAssert.equal(cause.maximumBytes, retainedBytes - 1);
      NodeAssert.equal(cause.retainedBytes, retainedBytes);
      return true;
    });
  });

  it("bounds cumulative normalized stream state across individually valid events", async () => {
    const nativeEvents = [
      {
        type: "session.text.started",
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 },
      },
      {
        type: "session.text.delta",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          delta: "abc",
        },
      },
      {
        type: "session.text.delta",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          delta: "def",
        },
      },
    ];
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of nativeEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: {
        sseEventBytes: 1_024,
        streamStateBytes: textPartRetainedBytes({ sessionID: "ses_1", messageID: "msg_1" }) + 5,
      },
    });
    const subscription = await client.event.subscribe();

    await NodeAssert.rejects(
      async () => {
        for await (const _event of subscription.stream) {
          // Consume until cumulative retained state crosses the limit.
        }
      },
      (cause: unknown) => {
        NodeAssert.ok(cause instanceof OpenCodeV2StreamStateOverflowError);
        NodeAssert.equal(
          cause.maximumBytes,
          textPartRetainedBytes({ sessionID: "ses_1", messageID: "msg_1" }) + 5,
        );
        NodeAssert.equal(
          cause.retainedBytes,
          textPartRetainedBytes({ sessionID: "ses_1", messageID: "msg_1" }) + 6,
        );
        return true;
      },
    );
  });

  it("releases completed stream parts instead of exhausting the active-part ceiling", async () => {
    const nativeEvents = ["msg_1", "msg_2"].flatMap((assistantMessageID) => [
      {
        type: "session.text.started",
        data: { sessionID: "ses_1", assistantMessageID, ordinal: 0 },
      },
      {
        type: "session.text.ended",
        data: { sessionID: "ses_1", assistantMessageID, ordinal: 0, text: "done" },
      },
    ]);
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of nativeEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { activeStreamParts: 1 },
    });
    const subscription = await client.event.subscribe();
    const events = [];
    for await (const event of subscription.stream) events.push(event);

    NodeAssert.equal(events.filter((event) => event.type === "message.part.updated").length, 4);
  });

  it("releases unfinished parts when their session reaches a terminal event", async () => {
    const nativeEvents = [
      {
        type: "session.text.started",
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 },
      },
      { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      {
        type: "session.text.started",
        data: { sessionID: "ses_2", assistantMessageID: "msg_2", ordinal: 0 },
      },
    ];
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of nativeEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { activeStreamParts: 1 },
    });
    const subscription = await client.event.subscribe();
    const events: Array<{ readonly type: string }> = [];
    for await (const event of subscription.stream) events.push(event);

    NodeAssert.equal(events.filter((event) => event.type === "message.updated").length, 2);
  });

  it("releases unfinished parts and correlations when execution is interrupted", async () => {
    const nativeEvents = [
      {
        type: "session.text.started",
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 },
      },
      {
        type: "session.execution.interrupted",
        data: { sessionID: "ses_1", reason: "user" },
      },
      {
        type: "question.v2.asked",
        data: { id: "que_1", sessionID: "ses_1", questions: [] },
      },
      {
        type: "session.execution.interrupted",
        data: { sessionID: "ses_1", reason: "superseded" },
      },
      {
        type: "session.text.started",
        data: { sessionID: "ses_2", assistantMessageID: "msg_2", ordinal: 0 },
      },
    ];
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of nativeEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { activeStreamParts: 1 },
    });
    const subscription = await client.event.subscribe();
    const events: Array<{ readonly type: string }> = [];
    for await (const event of subscription.stream) events.push(event);

    NodeAssert.equal(events.filter((event) => event.type === "message.updated").length, 2);
    NodeAssert.equal(events.filter((event) => event.type === "question.asked").length, 1);
    NodeAssert.equal(
      events.filter((event) => event.type === "session.execution.interrupted").length,
      2,
    );
  });

  it("releases unfinished stream state when a subscription closes", async () => {
    let requestNumber = 0;
    const baseUrl = await listen((_req, res) => {
      requestNumber += 1;
      const nativeEvent = {
        type: "session.text.started",
        data: {
          sessionID: `ses_${requestNumber}`,
          assistantMessageID: `msg_${requestNumber}`,
          ordinal: 0,
        },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(nativeEvent)}\n\n`);
    });
    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { activeStreamParts: 1 },
    });

    for (let subscriptionNumber = 0; subscriptionNumber < 2; subscriptionNumber += 1) {
      const subscription = await client.event.subscribe();
      for await (const _event of subscription.stream) {
        // The first subscription's retained state must not poison the second.
      }
    }
    NodeAssert.equal(requestNumber, 2);
  });

  it("projects native V2 streaming, completion, and permission events to the legacy adapter contract", async () => {
    const nativeEvents = [
      {
        id: "evt_1",
        created: 100,
        type: "session.execution.started",
        data: { sessionID: "ses_1" },
      },
      {
        id: "evt_2",
        created: 101,
        type: "session.text.started",
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 },
      },
      {
        id: "evt_3",
        created: 102,
        type: "session.text.delta",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          delta: "hello",
        },
      },
      {
        id: "evt_4",
        created: 103,
        type: "session.text.ended",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          text: "hello",
        },
      },
      {
        id: "evt_5",
        created: 104,
        type: "permission.asked",
        data: {
          id: "per_1",
          sessionID: "ses_1",
          action: "bash",
          resources: ["npm test"],
        },
      },
      {
        id: "evt_6",
        created: 105,
        type: "session.execution.succeeded",
        data: { sessionID: "ses_1" },
      },
    ];
    const baseUrl = await listen((req, res) => {
      if (req.url === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of nativeEvents) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
    });
    const subscription = await client.event.subscribe();
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    for await (const event of subscription.stream) {
      events.push(event as { type: string; properties: Record<string, unknown> });
    }

    NodeAssert.equal(events[0]?.type, "session.status");
    NodeAssert.deepEqual(events[0]?.properties.status, { type: "busy" });
    NodeAssert.ok(events.some((event) => event.type === "message.updated"));
    NodeAssert.ok(events.some((event) => event.type === "message.part.updated"));
    const delta = events.find((event) => event.type === "message.part.delta");
    NodeAssert.equal(delta?.properties.delta, "hello");
    NodeAssert.equal(typeof delta?.properties.partID, "string");
    const permission = events.find((event) => event.type === "permission.asked");
    NodeAssert.equal(permission?.properties.permission, "bash");
    NodeAssert.deepEqual(permission?.properties.patterns, ["npm test"]);
    NodeAssert.equal(events.at(-1)?.type, "session.status");
    NodeAssert.deepEqual(events.at(-1)?.properties.status, { type: "idle" });
  });

  it("converts prompt parts and waits for history", async () => {
    const calls: string[] = [];
    const baseUrl = await listen(async (req, res) => {
      const url = req.url ?? "";
      calls.push(`${req.method} ${url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url === "/api/session/ses_1/model") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "POST" && url === "/api/session/ses_1/prompt") {
        const body = JSON.parse(await readBody(req)) as { text?: string };
        NodeAssert.equal(body.text, "hello");
        res.end(JSON.stringify({ data: { id: "msg_user" } }));
        return;
      }
      if (req.method === "POST" && url === "/api/session/ses_1/wait") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "GET" && url.startsWith("/api/session/ses_1/message")) {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "msg_assistant",
                type: "assistant",
                time: { created: 1, completed: 2 },
                content: [{ type: "text", text: "world" }],
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2CompatibilityClient({
      baseUrl,
      directory: "/tmp/project",
    });
    const result = await client.session.prompt({
      sessionID: "ses_1",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      parts: [{ type: "text", text: "hello" }],
    });
    NodeAssert.equal(result.data?.info?.id, "msg_assistant");
    NodeAssert.equal(
      (result.data?.parts as Array<{ type: string; text?: string }> | undefined)?.[0]?.text,
      "world",
    );
    NodeAssert.ok(calls.some((call) => call.includes("/prompt")));
    NodeAssert.ok(calls.some((call) => call.includes("/wait")));
  });
});
