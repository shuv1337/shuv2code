// @effect-diagnostics nodeBuiltinImport:off

import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";

import { afterEach, describe, it } from "vite-plus/test";

import { createOpenCodeV2Client, OpenCodeV2EventTooLargeError } from "./opencodeV2Client.ts";

describe("createOpenCodeV2Client", () => {
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

  it("yields live SSE envelopes including nested form session ids and tool ids", async () => {
    const baseUrl = await listen((req, res) => {
      NodeAssert.equal(req.url, "/api/event");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "evt_form",
          type: "form.created",
          created: 1_700_000_000_000,
          data: { form: { id: "frm_1", sessionID: "ses_live", fields: [] } },
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "evt_tool",
          type: "session.tool.success",
          created: 1_700_000_000_001,
          data: { sessionID: "ses_live", id: "call_1", assistantMessageID: "msg_1" },
          durable: { aggregateID: "ses_live", seq: 2, version: 2 },
        })}\n\n`,
      );
      res.end();
    });

    const client = createOpenCodeV2Client({
      baseUrl,
      directory: "/tmp/project",
    });
    const events = [];
    for await (const event of client.event.subscribe()) {
      events.push(event);
    }
    NodeAssert.equal(events[0]?.type, "form.created");
    NodeAssert.equal(
      (events[0]?.data as { form?: { sessionID?: string } } | undefined)?.form?.sessionID,
      "ses_live",
    );
    NodeAssert.equal(events[1]?.type, "session.tool.success");
    NodeAssert.equal((events[1]?.data as { id?: string } | undefined)?.id, "call_1");
    NodeAssert.ok(events[1]?.durable);
  });

  it("hits live form list/reply/cancel and permission reply routes", async () => {
    const seen: string[] = [];
    const baseUrl = await listen(async (req, res) => {
      const url = new URL(req.url ?? "", "http://localhost");
      seen.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/api/session/ses_1/form") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "frm_1", sessionID: "ses_1", fields: [] }] }));
        return;
      }
      if (url.pathname === "/api/session/ses_1/form/frm_1/reply") {
        NodeAssert.deepEqual(JSON.parse(await readBody(req)), { answer: { q0: "yes" } });
        res.statusCode = 204;
        res.end();
        return;
      }
      if (
        url.pathname === "/api/session/ses_1/form/frm_1/cancel" ||
        url.pathname === "/api/session/ses_1/permission/per_1/reply"
      ) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2Client({
      baseUrl,
      directory: "/tmp/project",
    });
    const forms = await client.form.list("ses_1");
    NodeAssert.equal((forms[0] as { id?: string }).id, "frm_1");
    await client.form.reply("ses_1", "frm_1", { q0: "yes" });
    await client.form.cancel("ses_1", "frm_1");
    await client.permission.reply("ses_1", "per_1", "once");
    NodeAssert.deepEqual(seen, [
      "GET /api/session/ses_1/form",
      "POST /api/session/ses_1/form/frm_1/reply",
      "POST /api/session/ses_1/form/frm_1/cancel",
      "POST /api/session/ses_1/permission/per_1/reply",
    ]);
  });

  it("creates, prompts, interrupts, waits, and forks with live payloads", async () => {
    const seen: Array<{ method?: string; path: string; body?: unknown }> = [];
    const baseUrl = await listen(async (req, res) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : undefined;
      seen.push({ ...(req.method ? { method: req.method } : {}), path: url.pathname, body });
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/session" || url.pathname.endsWith("/fork")) {
        res.end(
          JSON.stringify({
            data: { id: "ses_2", title: "forked", location: { directory: "/tmp/project" } },
          }),
        );
        return;
      }
      if (url.pathname.endsWith("/prompt")) {
        res.end(JSON.stringify({ data: { id: "pending_1" } }));
        return;
      }
      if (url.pathname.endsWith("/interrupt") || url.pathname.endsWith("/wait")) {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url.pathname === "/api/session/active") {
        res.end(JSON.stringify({ data: { ses_2: { type: "running" } } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = createOpenCodeV2Client({
      baseUrl,
      directory: "/tmp/project",
    });
    const created = await client.session.create({ title: "work" });
    NodeAssert.equal(created.id, "ses_2");
    await client.session.prompt("ses_2", { text: "hello" });
    await client.session.interrupt("ses_2");
    await client.session.wait("ses_2");
    await client.session.fork("ses_2", { boundary: { type: "through" } });
    const active = await client.session.active();
    NodeAssert.equal(active.ses_2?.type, "running");
    NodeAssert.deepEqual(
      seen.map((entry) => `${entry.method} ${entry.path}`),
      [
        "POST /api/session",
        "POST /api/session/ses_2/prompt",
        "POST /api/session/ses_2/interrupt",
        "POST /api/session/ses_2/wait",
        "POST /api/session/ses_2/fork",
        "GET /api/session/active",
      ],
    );
    NodeAssert.deepEqual(seen[4]?.body, { boundary: { type: "through" } });
  });

  it("rejects oversized SSE events", async () => {
    const baseUrl = await listen((req, res) => {
      NodeAssert.equal(req.url, "/api/event");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${"x".repeat(64)}\n\n`);
      res.end();
    });
    const client = createOpenCodeV2Client({
      baseUrl,
      directory: "/tmp/project",
      bufferLimits: { sseEventBytes: 16 },
    });
    await NodeAssert.rejects(async () => {
      for await (const _event of client.event.subscribe()) {
        void _event;
      }
    }, OpenCodeV2EventTooLargeError);
  });
});
