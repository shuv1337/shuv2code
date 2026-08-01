import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import type * as CodexError from "./errors.ts";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );

  it.effect("invokes onTermination exactly once when the transport input stream ends", () =>
    Effect.gen(function* () {
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const terminationCount = yield* Ref.make(0);
      const scope = yield* Scope.make();
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.empty,
        stdout: () => Sink.drain,
        stderr: () => Sink.drain,
      });
      const context = yield* Layer.buildWithScope(
        CodexClient.layer(stdio, {
          onTermination: (error) =>
            Ref.update(terminationCount, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(terminated, error)),
              Effect.asVoid,
            ),
        }),
        scope,
      );

      const error = yield* Effect.gen(function* () {
        yield* Effect.service(CodexClient.CodexAppServerClient);
        return yield* Deferred.await(terminated).pipe(Effect.timeout("5 seconds"));
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(error._tag, "CodexAppServerInputStreamEndedError");
      assert.equal(yield* Ref.get(terminationCount), 1);
    }),
  );

  it.effect("uses typed steering and all realtime request methods", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(CodexClient.layerChildProcess(handle), scope);

      yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        yield* client.handleServerNotification("thread/realtime/started", (payload) =>
          Ref.update(started, (current) => [...current, payload]),
        );

        const steered = yield* client.request("turn/steer", {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          clientUserMessageId: "message-1",
          input: [{ type: "text", text: "steer" }],
        });
        assert.deepEqual(steered, { turnId: "turn-1" });

        yield* client.request("thread/realtime/start", {
          threadId: "thread-1",
          realtimeSessionId: "realtime-1",
          version: "v3",
          outputModality: "audio",
          clientManagedHandoffs: true,
          transport: { type: "webrtc", sdp: "offer" },
        });
        yield* client.request("thread/realtime/appendAudio", {
          threadId: "thread-1",
          audio: {
            data: "AQID",
            sampleRate: 24_000,
            numChannels: 1,
            samplesPerChannel: 3,
          },
        });
        yield* client.request("thread/realtime/appendText", {
          threadId: "thread-1",
          text: "context",
          role: "developer",
        });
        yield* client.request("thread/realtime/appendSpeech", {
          threadId: "thread-1",
          text: "spoken update",
        });
        const voices = yield* client.request("thread/realtime/listVoices", {});
        assert.deepEqual(voices.voices, {
          v1: ["cove"],
          v2: ["marin"],
          defaultV1: "cove",
          defaultV2: "marin",
        });
        yield* client.request("thread/realtime/stop", { threadId: "thread-1" });
        yield* Effect.yieldNow;
        assert.deepEqual(yield* Ref.get(started), [
          {
            threadId: "thread-1",
            realtimeSessionId: "realtime-1",
            version: "v3",
          },
        ]);
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );
});
