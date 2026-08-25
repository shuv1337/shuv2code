import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import * as net from "node:net";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@shuv2code/contracts";
import type { BotId } from "@shuv2code/contracts";

import {
  ADE_SCREEN_VIEWER_PREFIX,
  decideScreenViewerRequest,
  relayViewerToDesktop,
  screenViewerBotIdFromPath,
  screenViewerPathFor,
} from "./AdeScreenViewerRoute.ts";
import { AdeScreenboxProvisionError, type AdeScreenboxRuntimeShape } from "./AdeScreenbox.ts";

const OPERATE = [AuthOrchestrationOperateScope];

/** A `viewerTargetFor` that records every bot it was asked about. */
const stubScreenbox = (
  answer: (botId: BotId) => Effect.Effect<{ host: string; port: number }, AdeScreenboxProvisionError>,
) => {
  const asked: Array<string> = [];
  const screenbox: Pick<AdeScreenboxRuntimeShape, "viewerTargetFor"> = {
    viewerTargetFor: (botId) => {
      asked.push(botId);
      return answer(botId);
    },
  };
  return { asked, screenbox };
};

const running = (port: number) => (_botId: BotId) => Effect.succeed({ host: "127.0.0.1", port });

const refused = (botId: BotId) =>
  Effect.fail(
    new AdeScreenboxProvisionError({
      botId,
      kind: "not-eligible",
      reason: "This bot's desktop is not running. Start it from the Screen tab.",
    }),
  );

describe("screenViewerBotIdFromPath", () => {
  it("reads the bot id out of a viewer path", () => {
    assert.strictEqual(screenViewerBotIdFromPath(`${ADE_SCREEN_VIEWER_PREFIX}/bot-a`), "bot-a");
  });

  it("round-trips an id that needs escaping", () => {
    const botId = "bot/with slash" as BotId;
    assert.strictEqual(screenViewerBotIdFromPath(screenViewerPathFor(botId)), botId);
  });

  it("rejects paths that do not name exactly one bot", () => {
    // A nested path must not silently resolve to its first segment: that would
    // let `/ade/screen/bot-a/../bot-b` style confusion reach a desktop lookup.
    assert.isNull(screenViewerBotIdFromPath(`${ADE_SCREEN_VIEWER_PREFIX}/bot-a/extra`));
    assert.isNull(screenViewerBotIdFromPath(`${ADE_SCREEN_VIEWER_PREFIX}/`));
    assert.isNull(screenViewerBotIdFromPath(ADE_SCREEN_VIEWER_PREFIX));
    assert.isNull(screenViewerBotIdFromPath("/ws"));
    assert.isNull(screenViewerBotIdFromPath("/ade/screenbox/bot-a"));
    // A malformed escape is a malformed request, not a bot literally named "%zz".
    assert.isNull(screenViewerBotIdFromPath(`${ADE_SCREEN_VIEWER_PREFIX}/%zz`));
    assert.isNull(screenViewerBotIdFromPath(`${ADE_SCREEN_VIEWER_PREFIX}/%20%20`));
  });
});

describe("decideScreenViewerRequest", () => {
  it.effect("resolves a running desktop for an operate-scoped session", () =>
    Effect.gen(function* () {
      const { asked, screenbox } = stubScreenbox(running(5901));
      const decision = yield* decideScreenViewerRequest({
        scopes: OPERATE,
        pathname: screenViewerPathFor("bot-a" as BotId),
        screenbox,
      });
      assert.strictEqual(decision._tag, "relay");
      if (decision._tag === "relay") {
        assert.strictEqual(decision.botId, "bot-a");
        assert.deepStrictEqual(decision.target, { host: "127.0.0.1", port: 5901 });
      }
      // Only the bot named in the path is ever looked up.
      assert.deepStrictEqual(asked, ["bot-a"]);
    }),
  );

  it.effect("refuses a read-only session without disclosing whether a desktop exists", () =>
    Effect.gen(function* () {
      const { asked, screenbox } = stubScreenbox(running(5901));
      const decision = yield* decideScreenViewerRequest({
        scopes: [AuthOrchestrationReadScope],
        pathname: screenViewerPathFor("bot-a" as BotId),
        screenbox,
      });
      assert.strictEqual(decision._tag, "forbidden");
      // The scope check must short-circuit before the lookup, or the caller
      // could map live desktops by diffing 403 against 409.
      assert.deepStrictEqual(asked, []);
    }),
  );

  it.effect("refuses a session with no scopes at all", () =>
    Effect.gen(function* () {
      const { asked, screenbox } = stubScreenbox(running(5901));
      const decision = yield* decideScreenViewerRequest({
        scopes: [],
        pathname: screenViewerPathFor("bot-a" as BotId),
        screenbox,
      });
      assert.strictEqual(decision._tag, "forbidden");
      assert.deepStrictEqual(asked, []);
    }),
  );

  it.effect("reports a stopped desktop as unavailable rather than starting one", () =>
    Effect.gen(function* () {
      const { screenbox } = stubScreenbox(refused);
      const decision = yield* decideScreenViewerRequest({
        scopes: OPERATE,
        pathname: screenViewerPathFor("bot-a" as BotId),
        screenbox,
      });
      assert.strictEqual(decision._tag, "unavailable");
    }),
  );

  it.effect("never reaches a lookup for a path that names no bot", () =>
    Effect.gen(function* () {
      const { asked, screenbox } = stubScreenbox(running(5901));
      const decision = yield* decideScreenViewerRequest({
        scopes: OPERATE,
        pathname: `${ADE_SCREEN_VIEWER_PREFIX}/bot-a/extra`,
        screenbox,
      });
      assert.strictEqual(decision._tag, "not-found");
      assert.deepStrictEqual(asked, []);
    }),
  );
});

/**
 * A `Socket.Socket` standing in for the captain's browser: whatever the relay
 * writes lands in `sent`, and `deliver` pushes bytes as if the viewer sent them.
 */
const fakeViewerSocket = Effect.gen(function* () {
  const inbound = yield* Queue.bounded<Uint8Array>(32);
  const sent: Array<Uint8Array> = [];
  const socket = Socket.make({
    runRaw: (handler) =>
      Queue.take(inbound).pipe(
        Effect.flatMap((chunk) => {
          const result = handler(chunk);
          return Effect.isEffect(result) ? (result as Effect.Effect<unknown>) : Effect.void;
        }),
        Effect.forever,
      ) as Effect.Effect<void, never, never>,
    writer: Effect.succeed((chunk: Uint8Array | string | Socket.CloseEvent) =>
      Effect.sync(() => {
        if (chunk instanceof Uint8Array) sent.push(chunk);
      }),
    ),
  });
  return {
    socket,
    sent,
    deliver: (bytes: Uint8Array) => Queue.offer(inbound, bytes),
  };
});

/** A TCP server standing in for a desktop's raw RFB listener. */
const startFakeDesktop = (
  onConnection: (connection: net.Socket) => void,
): Effect.Effect<{ port: number }, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ port: number; server: net.Server }>((resume) => {
      const server = net.createServer(onConnection);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            port: typeof address === "object" && address !== null ? address.port : 0,
            server,
          }),
        );
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(({ port }) => ({ port })));

const concat =(chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

describe("relayViewerToDesktop", () => {
  it.live("carries an RFB handshake in both directions byte for byte", () =>
    Effect.gen(function* () {
      // Includes a zero byte and a high byte: a relay that treated the stream
      // as text would mangle both, and RFB never recovers from a mangled byte.
      const reply = Uint8Array.from([0x52, 0x46, 0x42, 0x00, 0xff, 0x01]);
      const received: Array<Uint8Array> = [];
      const desktop = yield* startFakeDesktop((connection) => {
        // A real desktop greets first: this is the exact banner the live
        // Screenbox desktop sends on its `vnc_port`.
        connection.write("RFB 003.008\n");
        connection.on("data", (chunk) => {
          received.push(Uint8Array.from(chunk));
          // Hang up once the client's half of the handshake has arrived, so the
          // relay completes on its own and the assertions are not racing it.
          if (concat(received).byteLength >= reply.byteLength) connection.end();
        });
      });
      const viewer = yield* fakeViewerSocket;
      // Queue the viewer's bytes before the relay starts; the fake socket
      // buffers them, exactly as a browser can send before the server reads.
      yield* viewer.deliver(reply);

      yield* Effect.scoped(
        relayViewerToDesktop(viewer.socket, { host: "127.0.0.1", port: desktop.port }),
      ).pipe(Effect.timeoutOption("10 seconds"), Effect.orDie);

      // Desktop → viewer.
      assert.strictEqual(new TextDecoder().decode(concat(viewer.sent)), "RFB 003.008\n");
      // Viewer → desktop, byte for byte.
      assert.deepStrictEqual([...concat(received)], [...reply]);
    }),
  );

  it.live("ends the session when the desktop hangs up", () =>
    Effect.gen(function* () {
      const desktop = yield* startFakeDesktop((connection) => {
        connection.write("bye");
        connection.end();
      });
      const viewer = yield* fakeViewerSocket;

      // A desktop that closes must complete the relay rather than leave the
      // request fiber parked forever holding a viewer against the idle sweep.
      const finished = yield* Effect.scoped(
        relayViewerToDesktop(viewer.socket, { host: "127.0.0.1", port: desktop.port }),
      ).pipe(
        Effect.as("relay ended" as const),
        Effect.timeoutOption("5 seconds"),
        Effect.orDie,
      );
      assert.deepStrictEqual(finished, Option.some("relay ended"));
      assert.strictEqual(new TextDecoder().decode(concat(viewer.sent)), "bye");
    }),
  );

  it.live("fails instead of hanging when nothing is listening on the port", () =>
    Effect.gen(function* () {
      // Bind and immediately release a port so we know it is closed.
      const closed = yield* Effect.scoped(startFakeDesktop(() => {}));
      const viewer = yield* fakeViewerSocket;

      const outcome = yield* Effect.scoped(
        relayViewerToDesktop(viewer.socket, { host: "127.0.0.1", port: closed.port }),
      ).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
    }),
  );
});
