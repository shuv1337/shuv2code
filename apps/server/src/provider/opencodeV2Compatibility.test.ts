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
    });
    await client.permission.reply({ requestID: "perm-1", reply: "once" });
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
