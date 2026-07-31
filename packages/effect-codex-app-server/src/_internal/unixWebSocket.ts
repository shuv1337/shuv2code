import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as crypto from "node:crypto";
import * as net from "node:net";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const transportFail = (cause: unknown) =>
  new CodexError.CodexAppServerTransportError({
    operation: "read-input-stream",
    cause,
  });

/**
 * Build an Effect Stdio façade over a WebSocket connection to a local Unix
 * socket. Codex app-server speaks one JSON-RPC message per WebSocket text frame;
 * we adapt that to the newline-delimited JSON stream the protocol layer expects.
 */
export const makeUnixWebSocketStdio = Effect.fn("effect-codex-app-server/makeUnixWebSocketStdio")(
  function* (socketPath: string) {
    const incoming = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
    const outgoing = yield* Queue.unbounded<string>();

    const socket = yield* Effect.tryPromise({
      try: () =>
        new Promise<net.Socket>((resolve, reject) => {
          const sock = net.createConnection(socketPath);
          sock.once("error", reject);
          sock.once("connect", () => resolve(sock));
        }),
      catch: transportFail,
    });

    const key = crypto.randomBytes(16).toString("base64");
    const handshake = [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      "\r\n",
    ].join("\r\n");

    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          let buffer = "";
          const onData = (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("\r\n\r\n")) {
              socket.off("data", onData);
              if (!/^HTTP\/1\.1 101/i.test(buffer)) {
                reject(new Error(`WebSocket upgrade failed: ${buffer.slice(0, 200)}`));
                return;
              }
              resolve();
            }
          };
          socket.on("data", onData);
          socket.once("error", reject);
          socket.write(handshake);
        }),
      catch: transportFail,
    });

    // Reader: decode WS text frames into newline-delimited JSON for the protocol.
    yield* Effect.forkScoped(
      Effect.callback<void>((resume) => {
        let residual = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          residual = Buffer.concat([residual, chunk]);
          while (residual.length >= 2) {
            const b0 = residual[0]!;
            const b1 = residual[1]!;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
              if (residual.length < 4) return;
              len = residual.readUInt16BE(2);
              offset = 4;
            } else if (len === 127) {
              if (residual.length < 10) return;
              len = Number(residual.readBigUInt64BE(2));
              offset = 10;
            }
            const maskLen = masked ? 4 : 0;
            if (residual.length < offset + maskLen + len) return;
            let payload = residual.subarray(offset + maskLen, offset + maskLen + len);
            if (masked) {
              const mask = residual.subarray(offset, offset + 4);
              payload = Buffer.from(payload);
              for (let i = 0; i < payload.length; i++) {
                payload[i] = payload[i]! ^ mask[i % 4]!;
              }
            }
            residual = residual.subarray(offset + maskLen + len);
            if (opcode === 0x8) {
              void Queue.end(incoming);
              resume(Effect.void);
              return;
            }
            if (opcode === 0x1 || opcode === 0x2) {
              const text = decoder.decode(payload);
              void Queue.offer(incoming, encoder.encode(`${text}\n`));
            }
          }
        };
        socket.on("data", onData);
        socket.on("close", () => {
          void Queue.end(incoming);
          resume(Effect.void);
        });
        socket.on("error", (error) => {
          void Queue.end(incoming);
          resume(Effect.die(error));
        });
        return Effect.sync(() => {
          socket.off("data", onData);
        });
      }),
    );

    // Writer: encode outgoing NDJSON lines as masked client WS text frames.
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.runForEach((line) =>
        Effect.sync(() => {
          const payload = encoder.encode(line.endsWith("\n") ? line.slice(0, -1) : line);
          const len = payload.length;
          let header: Buffer;
          if (len < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x81;
            header[1] = len;
          } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(len, 2);
          } else {
            header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
          }
          header[1] = header[1]! | 0x80;
          const mask = crypto.randomBytes(4);
          const masked = Buffer.from(payload);
          for (let i = 0; i < masked.length; i++) {
            masked[i] = masked[i]! ^ mask[i % 4]!;
          }
          socket.write(Buffer.concat([header, mask, masked]));
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          socket.end();
        } catch {
          // ignore
        }
      }),
    );

    return Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(incoming),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(outgoing, typeof chunk === "string" ? chunk : decoder.decode(chunk)),
        ),
      stderr: () => Sink.drain,
    });
  },
);
