// @effect-diagnostics nodeBuiltinImport:off

import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";

import { afterEach, describe, it } from "vite-plus/test";

import { createOpenCodeV2CompatibilityClient } from "./opencodeV2Compatibility.ts";

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
