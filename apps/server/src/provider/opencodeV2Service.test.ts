// @effect-diagnostics nodeBuiltinImport:off

import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import { afterEach, describe, it } from "vite-plus/test";

import {
  detectOpenCodeServerProtocol,
  discoverOpenCodeV2Service,
  OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES,
  OpenCodeV2HealthResponseTooLargeError,
  openCodeV2ChannelFromVersion,
  openCodeV2ServiceRegistrationFileName,
  parseOpenCodeV2ServiceRegistration,
  readOpenCodeV2HealthResponse,
  requireOpenCodeV2Service,
  resolveOpenCodeV2ServiceRegistrationPath,
} from "./opencodeV2Service.ts";

describe("openCodeV2Service registration helpers", () => {
  it("maps channel prerelease versions to the channel registration file", () => {
    NodeAssert.equal(openCodeV2ChannelFromVersion("0.0.0-next-202607220047"), "next");
    NodeAssert.equal(
      openCodeV2ServiceRegistrationFileName("0.0.0-next-202607220047"),
      "service.json",
    );
    NodeAssert.equal(openCodeV2ChannelFromVersion("0.0.0-local-1"), "local");
    NodeAssert.equal(openCodeV2ServiceRegistrationFileName("0.0.0-local-1"), "service-local.json");
  });

  it("uses service.json for latest/next, stable semver, and published prereleases", () => {
    NodeAssert.equal(openCodeV2ServiceRegistrationFileName("latest"), "service.json");
    NodeAssert.equal(openCodeV2ServiceRegistrationFileName("next"), "service.json");
    NodeAssert.equal(openCodeV2ServiceRegistrationFileName("2.0.0"), "service.json");
    NodeAssert.equal(openCodeV2ChannelFromVersion("2.0.0-alpha-4"), "latest");
    NodeAssert.equal(openCodeV2ServiceRegistrationFileName("2.0.0-alpha-4"), "service.json");
    NodeAssert.equal(openCodeV2ChannelFromVersion("2.0.0-beta.1"), "latest");
    NodeAssert.equal(openCodeV2ServiceRegistrationFileName("2.0.0-rc.3"), "service.json");
  });

  it("resolves under XDG_STATE_HOME/opencode", () => {
    const path = resolveOpenCodeV2ServiceRegistrationPath({
      version: "0.0.0-beta-1",
      environment: { XDG_STATE_HOME: "/tmp/xdg-state" },
    });
    NodeAssert.equal(path, "/tmp/xdg-state/opencode/service-beta.json");
  });

  it("parses registration JSON and rejects invalid payloads", () => {
    const parsed = parseOpenCodeV2ServiceRegistration(
      JSON.stringify({
        id: "abc",
        version: "0.0.0-beta-1",
        url: "http://127.0.0.1:4096",
        pid: 123,
        password: "secret",
      }),
    );
    NodeAssert.deepEqual(parsed, {
      id: "abc",
      version: "0.0.0-beta-1",
      url: "http://127.0.0.1:4096",
      pid: 123,
      password: "secret",
    });
    NodeAssert.equal(parseOpenCodeV2ServiceRegistration("{"), null);
    NodeAssert.equal(parseOpenCodeV2ServiceRegistration(JSON.stringify({ url: "x" })), null);
  });

  it("rejects a declared oversized health body without reading it", async () => {
    const response = new Response(null, {
      headers: { "content-length": String(OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES + 1) },
    });

    await NodeAssert.rejects(readOpenCodeV2HealthResponse(response), (cause: unknown) => {
      NodeAssert.ok(cause instanceof OpenCodeV2HealthResponseTooLargeError);
      NodeAssert.equal(cause.maximumBytes, OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES);
      NodeAssert.equal(cause.receivedBytes, OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES + 1);
      return true;
    });
  });

  it("rejects a chunked oversized health body and cancels its stream", async () => {
    let cancelled = false;
    const chunkBytes = 40 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(chunkBytes));
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        cancelled = true;
      },
    });

    await NodeAssert.rejects(readOpenCodeV2HealthResponse(new Response(body)), (cause: unknown) => {
      NodeAssert.ok(cause instanceof OpenCodeV2HealthResponseTooLargeError);
      NodeAssert.equal(cause.maximumBytes, OPEN_CODE_V2_HEALTH_RESPONSE_MAX_BYTES);
      NodeAssert.equal(cause.receivedBytes, chunkBytes * 2);
      return true;
    });
    NodeAssert.equal(cancelled, true);
  });
});

describe("openCodeV2Service discover/detect", () => {
  const servers: NodeHttp.Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(
      tempDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
  });

  async function listen(
    handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
  ): Promise<{ readonly url: string; readonly port: number }> {
    const server = NodeHttp.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp address");
    }
    return { url: `http://127.0.0.1:${address.port}`, port: address.port };
  }

  it("discovers a healthy registered V2 service", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "shuv2code-oc-v2-"));
    tempDirs.push(stateDir);
    const openCodeState = NodePath.join(stateDir, "opencode");
    await NodeFSP.mkdir(openCodeState, { recursive: true });

    const authHeader = `Basic ${Buffer.from("opencode:test-password", "utf8").toString("base64")}`;
    const { url } = await listen((req, res) => {
      if (req.url !== "/api/health") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers.authorization !== authHeader) {
        res.statusCode = 401;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true, version: "0.0.0-beta-1", pid: process.pid }));
    });

    await NodeFSP.writeFile(
      NodePath.join(openCodeState, "service-beta.json"),
      JSON.stringify({
        version: "0.0.0-beta-1",
        url,
        pid: process.pid,
        password: "test-password",
      }),
      { mode: 0o600 },
    );

    const endpoint = await discoverOpenCodeV2Service({
      version: "0.0.0-beta-1",
      environment: { XDG_STATE_HOME: stateDir },
    });
    NodeAssert.ok(endpoint);
    NodeAssert.equal(endpoint.url, url);
    NodeAssert.equal(endpoint.password, "test-password");
    NodeAssert.equal(endpoint.version, "0.0.0-beta-1");
  });

  it("detects V2 external servers via /api/health", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ healthy: true, version: "2.0.0", pid: 1 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    NodeAssert.equal(await detectOpenCodeServerProtocol({ baseUrl: url }), "v2");
  });

  it("falls back to V1 when only /global/health responds", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/global/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ healthy: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    NodeAssert.equal(await detectOpenCodeServerProtocol({ baseUrl: url }), "v1");
  });

  it("requireOpenCodeV2Service fails clearly when no service is registered", async () => {
    const stateDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "shuv2code-oc-v2-missing-"),
    );
    tempDirs.push(stateDir);
    await NodeAssert.rejects(
      () =>
        requireOpenCodeV2Service({
          version: "0.0.0-beta-1",
          environment: { XDG_STATE_HOME: stateDir },
        }),
      /background service is not running/,
    );
  });
});
