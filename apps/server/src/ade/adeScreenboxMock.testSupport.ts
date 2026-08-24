// @effect-diagnostics globalTimers:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * In-process mock of the upstream Screenbox surface (HTTP API + MCP Streamable
 * HTTP), modeled on `provider/opencodeV2Mock.testSupport.ts`.
 *
 * It is a real loopback HTTP server so tests exercise the actual client:
 * URL shapes, the admin-token headers, MCP framing, and error mapping. The
 * mock keeps a tiny desktop state machine (create/start/stop/destroy) so the
 * idle-stop → restart-on-need round trip is observable, and records every tool
 * call so scoping assertions can read the `desktop_id` upstream actually saw.
 */
import * as NodeHttp from "node:http";

export interface AdeScreenboxMockToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface AdeScreenboxMockRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface AdeScreenboxMockDesktop {
  state: "running" | "stopped";
}

export interface AdeScreenboxMockOptions {
  /** Tool descriptors returned by MCP `tools/list`. */
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
  }>;
  /** Reply as SSE frames instead of plain JSON (both are legal MCP). */
  readonly mcpSse?: boolean;
  /**
   * Delay `POST /api/desktop/control` responses, widening the window where an
   * idle stop and a live tool forward can interleave.
   */
  readonly controlDelayMs?: number;
}

export interface AdeScreenboxMock {
  readonly baseUrl: string;
  readonly desktops: Map<string, AdeScreenboxMockDesktop>;
  readonly toolCalls: Array<AdeScreenboxMockToolCall>;
  readonly requests: Array<AdeScreenboxMockRequest>;
  /** Force the next N `create` calls to fail (provisioning failure path). */
  failCreate: number;
  /** Force every `control` call to fail. */
  failControl: boolean;
  /** Force `GET /api/health` to fail at the transport level (non-2xx). */
  failHealth: boolean;
  /**
   * Upstream `issues` to report from `GET /api/health`. A non-empty list makes
   * the mock answer **200 with `ok: false`**, which is exactly how the real
   * service reports degradation — it never uses a non-2xx for it.
   */
  healthIssues: ReadonlyArray<string>;
  /** Force MCP `tools/list` to fail. */
  failToolsList: boolean;
  /** Force the next tool call to return an MCP error result. */
  failToolCall: boolean;
  readonly close: () => Promise<void>;
}

const DEFAULT_TOOLS: NonNullable<AdeScreenboxMockOptions["tools"]> = [
  { name: "desktop_screenshot" },
  { name: "desktop_click" },
  { name: "desktop_shell" },
  // Lifecycle + knowledge tools upstream also advertises; the plane must drop
  // these rather than expose them to a bot.
  { name: "desktop_manage" },
  { name: "knowledge_search" },
];

export async function startAdeScreenboxMock(
  options: AdeScreenboxMockOptions = {},
): Promise<AdeScreenboxMock> {
  const desktops = new Map<string, AdeScreenboxMockDesktop>();
  const toolCalls: Array<AdeScreenboxMockToolCall> = [];
  const requests: Array<AdeScreenboxMockRequest> = [];
  const toolDescriptors = options.tools ?? DEFAULT_TOOLS;

  const mock = {
    desktops,
    toolCalls,
    requests,
    failCreate: 0,
    failControl: false,
    failHealth: false,
    healthIssues: [] as ReadonlyArray<string>,
    failToolsList: false,
    failToolCall: false,
  } as {
    -readonly [K in keyof AdeScreenboxMock]: AdeScreenboxMock[K];
  };

  const readBody = (request: NodeHttp.IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length === 0) return resolve(undefined);
        try {
          resolve(JSON.parse(raw) as unknown);
        } catch {
          resolve(undefined);
        }
      });
    });

  const send = (response: NodeHttp.ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body ?? {});
    response.writeHead(status, { "content-type": "application/json" });
    response.end(payload);
  };

  const sendMcp = (
    response: NodeHttp.ServerResponse,
    id: unknown,
    payload: { result?: unknown; error?: { code: number; message: string } },
  ): void => {
    const message = { jsonrpc: "2.0", id, ...payload };
    if (options.mcpSse === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      return;
    }
    send(response, 200, message);
  };

  /**
   * Upstream's HTTP API reads `body.get("id")` on every lifecycle route — never
   * `desktop_id`, which is the MCP tool-argument spelling. Mirroring that
   * exactly is the point of this helper: a client that regresses to sending
   * only `desktop_id` must fail here the way it fails against the real service,
   * not quietly pass.
   */
  const desktopIdOf = (body: unknown): string => {
    const record = (body ?? {}) as Record<string, unknown>;
    const value = record["id"];
    return typeof value === "string" ? value.trim() : "";
  };

  /** Upstream's `400 {"error": "Missing id"}` for a body without a usable `id`. */
  const rejectMissingId = (response: NodeHttp.ServerResponse, desktopId: string): boolean => {
    if (desktopId.length > 0) return false;
    send(response, 400, { error: "Missing id" });
    return true;
  };

  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "GET",
        path,
        authorization: request.headers["authorization"],
        body,
      });

      if (path === "/api/health") {
        if (mock.failHealth) return send(response, 503, { error: "screenbox down" });
        // Note the shape: upstream is unauthenticated here and always 200,
        // carrying degradation in `ok`/`issues` rather than the status.
        return send(response, 200, {
          ok: mock.healthIssues.length === 0,
          desktops: desktops.size,
          issues: [...mock.healthIssues],
          ts: 0,
        });
      }

      if (path === "/api/desktop/list") {
        return send(response, 200, {
          desktops: [...desktops.entries()].map(([desktopId, desktop]) => ({
            desktop_id: desktopId,
            state: desktop.state,
          })),
        });
      }

      if (path === "/api/desktop/create") {
        const desktopId = desktopIdOf(body);
        if (rejectMissingId(response, desktopId)) return;
        if (mock.failCreate > 0) {
          mock.failCreate -= 1;
          return send(response, 500, { error: "docker create failed" });
        }
        desktops.set(desktopId, { state: "running" });
        return send(response, 200, { ok: true, desktop_id: desktopId, state: "running" });
      }

      if (path === "/api/desktop/control") {
        const desktopId = desktopIdOf(body);
        const action = (body as Record<string, unknown>)["action"];
        if (rejectMissingId(response, desktopId)) return;
        if (options.controlDelayMs !== undefined && options.controlDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.controlDelayMs));
        }
        if (mock.failControl) return send(response, 500, { error: "control failed" });
        const desktop = desktops.get(desktopId);
        if (desktop === undefined) return send(response, 404, { error: "unknown desktop" });
        if (action === "stop") desktop.state = "stopped";
        if (action === "start") desktop.state = "running";
        return send(response, 200, { desktop_id: desktopId, state: desktop.state });
      }

      if (path === "/api/desktop/destroy") {
        const desktopId = desktopIdOf(body);
        if (rejectMissingId(response, desktopId)) return;
        desktops.delete(desktopId);
        return send(response, 200, { ok: true, desktop_id: desktopId, destroyed: true });
      }

      if (path === "/api/desktop/delete-data") {
        const desktopId = desktopIdOf(body);
        if (rejectMissingId(response, desktopId)) return;
        // Upstream reports `deleted: true` here even when the home volume
        // survived the purge; the mock reproduces the optimistic answer.
        return send(response, 200, { ok: true, desktop_id: desktopId, deleted: true });
      }

      if (path === "/mcp") {
        const message = (body ?? {}) as Record<string, unknown>;
        const id = message["id"];
        const method = message["method"];
        if (method === "initialize") {
          return sendMcp(response, id, {
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          });
        }
        if (method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (method === "tools/list") {
          if (mock.failToolsList) {
            return sendMcp(response, id, { error: { code: -32000, message: "upstream down" } });
          }
          return sendMcp(response, id, {
            result: {
              tools: toolDescriptors.map((tool) => ({
                name: tool.name,
                description: tool.description ?? `${tool.name} description`,
                inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
              })),
            },
          });
        }
        if (method === "tools/call") {
          const params = (message["params"] ?? {}) as Record<string, unknown>;
          const name = String(params["name"] ?? "");
          const args = (params["arguments"] ?? {}) as Record<string, unknown>;
          toolCalls.push({ name, arguments: args });
          if (mock.failToolCall) {
            return sendMcp(response, id, {
              result: { isError: true, content: [{ type: "text", text: "tool exploded" }] },
            });
          }
          const desktopId = typeof args["desktop_id"] === "string" ? args["desktop_id"] : "";
          const desktop = desktops.get(desktopId);
          if (desktop === undefined || desktop.state !== "running") {
            return sendMcp(response, id, {
              result: {
                isError: true,
                content: [{ type: "text", text: `desktop ${desktopId} is not running` }],
              },
            });
          }
          return sendMcp(response, id, {
            result: { content: [{ type: "text", text: `ok:${name}:${desktopId}` }] },
          });
        }
        return sendMcp(response, id, { error: { code: -32601, message: "method not found" } });
      }

      send(response, 404, { error: "not found" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return Object.assign(mock, {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  }) as AdeScreenboxMock;
}
