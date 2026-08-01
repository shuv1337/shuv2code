import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as CodexClient from "../client.ts";

/**
 * Minimal WebSocket-over-unix-socket app-server stand-in: accepts the HTTP
 * upgrade, decodes one masked client text frame per JSON-RPC message, and
 * answers `initialize` with one unmasked text frame — the framing the real
 * `codex app-server --listen unix://` control socket speaks.
 */
const startMockUnixWsServer = (socketPath: string) => {
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        const key = /Sec-WebSocket-Key: (.+)/i.exec(header)?.[1]?.trim() ?? "";
        const accept = NodeCrypto.createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "connection: Upgrade",
            "upgrade: websocket",
            `sec-websocket-accept: ${accept}`,
            "\r\n",
          ].join("\r\n"),
        );
        upgraded = true;
      }
      while (buffer.length >= 2) {
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1]! & 0x80) !== 0;
        const maskLength = masked ? 4 : 0;
        if (buffer.length < offset + maskLength + length) return;
        let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index++) {
            payload[index] = payload[index]! ^ mask[index % 4]!;
          }
        }
        buffer = buffer.subarray(offset + maskLength + length);
        const message = JSON.parse(payload.toString("utf8")) as {
          id?: number;
          method?: string;
        };
        if (message.method === "initialize" && message.id !== undefined) {
          const response = Buffer.from(
            JSON.stringify({
              id: message.id,
              result: {
                userAgent: "mock-unix-ws-app-server",
                codexHome: "/tmp/mock-codex-home",
                platformFamily: "unix",
                platformOs: "linux",
              },
            }),
          );
          let frame: Buffer;
          if (response.length < 126) {
            frame = Buffer.alloc(2 + response.length);
            frame[0] = 0x81;
            frame[1] = response.length;
            response.copy(frame, 2);
          } else {
            frame = Buffer.alloc(4 + response.length);
            frame[0] = 0x81;
            frame[1] = 126;
            frame.writeUInt16BE(response.length, 2);
            response.copy(frame, 4);
          }
          socket.write(frame);
        }
      }
    });
  });
  const shutdown = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    });
  return new Promise<{ shutdown: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve({ shutdown }));
  });
};

it.layer(NodeServices.layer)("unix WebSocket control-socket client", (it) => {
  it.effect("round-trips a typed request over WebSocket frames and observes termination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const socketDir = yield* fs.makeTempDirectory({ prefix: "codex-unix-ws-" });
      const socketPath = pathService.join(socketDir, "control.sock");
      const server = yield* Effect.promise(() => startMockUnixWsServer(socketPath));
      const terminated = yield* Deferred.make<string>();
      const scope = yield* Scope.make();

      const context = yield* Layer.buildWithScope(
        CodexClient.layerUnixSocket(socketPath, {
          onTermination: (error) => Deferred.succeed(terminated, error._tag).pipe(Effect.asVoid),
        }),
        scope,
      );

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "unix-ws-test",
            title: "Unix WS Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(context));

      assert.equal(initialized.userAgent, "mock-unix-ws-app-server");

      // Server death must surface as connection termination.
      yield* Effect.promise(() => server.shutdown());
      const terminationTag = yield* Deferred.await(terminated).pipe(Effect.timeout("5 seconds"));
      assert.equal(terminationTag, "CodexAppServerInputStreamEndedError");

      yield* Scope.close(scope, Exit.void);
    }),
  );
});
