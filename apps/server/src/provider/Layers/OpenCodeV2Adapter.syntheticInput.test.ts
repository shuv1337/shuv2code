/**
 * The synthetic-input seam (ADE §3.4) against the upstream contract.
 *
 * Three upstream facts drive every assertion here, and each one was a live
 * defect before this suite existed:
 *
 *  1. upstream dedupes an admitted inbox item on its **id**, first-admission
 *     wins, and ignores `metadata` entirely — so carrying ADE's delivery key
 *     in metadata bought exactly nothing;
 *  2. upstream's delivery vocabulary is `steer | queue`. `"follow-up"` — the
 *     ADR's word, and the seam's — is rejected outright;
 *  3. admitting an item **wakes an idle session** unless `resume: false`.
 *     Delivery wants the wake; seeding a session with its persona projection
 *     very much does not.
 */
import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderDriverKind, ThreadId } from "@shuv2code/contracts";

import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { startOpenCodeV2Mock } from "../opencodeV2Mock.testSupport.ts";
import {
  makeOpenCodeV2Adapter,
  openCodeV2SyntheticDelivery,
  openCodeV2SyntheticItemId,
} from "./OpenCodeV2Adapter.ts";

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("not used"),
  connectToOpenCodeServer: () => Effect.die("not used"),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () => Effect.die("not used"),
  loadInventoryFromCli: () => Effect.die("not used"),
};

const TestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makeMockedAdapter = Effect.gen(function* () {
  const mock = yield* Effect.acquireRelease(
    Effect.promise(() => startOpenCodeV2Mock()),
    (started) => Effect.promise(() => started.close()),
  );
  const adapter = yield* makeOpenCodeV2Adapter(
    {
      enabled: true,
      binaryPath: "opencode",
      serverUrl: mock.baseUrl,
      serverPassword: "",
      customModels: [],
    },
    {},
  ).pipe(
    Effect.provideService(OpenCodeRuntime, {
      ...OpenCodeRuntimeTestDouble,
      connectToOpenCodeServer: () =>
        Effect.succeed({
          url: mock.baseUrl,
          exitCode: null,
          external: true,
          protocol: "v2" as const,
        }),
    }),
  );
  const synthetic = adapter.syntheticInput;
  NodeAssert.ok(synthetic, "OpenCodeV2 adapter must expose the synthetic input seam");
  const startThread = (threadId: ThreadId) =>
    adapter.startSession({
      provider: ProviderDriverKind.make("opencodeV2"),
      threadId,
      runtimeMode: "full-access",
    });
  return { mock, adapter, synthetic, startThread };
});

describe("openCodeV2SyntheticDelivery", () => {
  it("translates the seam's vocabulary into upstream's", () => {
    NodeAssert.equal(openCodeV2SyntheticDelivery("steer"), "steer");
    // Upstream has no "follow-up"; sending it is a 400.
    NodeAssert.equal(openCodeV2SyntheticDelivery("follow-up"), "queue");
  });
});

describe("openCodeV2SyntheticItemId", () => {
  it("prefixes the durable key so upstream accepts it, and stays stable", () => {
    const key = "delivery-abc";
    NodeAssert.ok(openCodeV2SyntheticItemId(key).startsWith("msg_"));
    NodeAssert.equal(openCodeV2SyntheticItemId(key), openCodeV2SyntheticItemId(key));
  });
});

describe("OpenCodeV2Adapter synthetic input", () => {
  it.effect("admits a redelivered key exactly once", () =>
    Effect.gen(function* () {
      const { mock, synthetic, startThread } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-synthetic-dedupe");
      yield* startThread(threadId);

      const batch = {
        threadId,
        text: "Assignment complete.",
        description: "ADE assignment results",
        delivery: "follow-up" as const,
        dedupeKey: "delivery-key-1",
      };
      yield* synthetic.inject(batch);
      // The crash-window replay: same durable claim, sent again.
      yield* synthetic.inject(batch);

      NodeAssert.equal(mock.syntheticRequests.length, 2);
      // Both carried the same id, derived from the durable key…
      const expectedId = openCodeV2SyntheticItemId("delivery-key-1");
      NodeAssert.deepEqual(
        mock.syntheticRequests.map((request) => request.id),
        [expectedId, expectedId],
      );
      // …so upstream admitted one item, not two.
      NodeAssert.deepEqual(
        mock.syntheticRequests.map((request) => request.admitted),
        [true, false],
      );
      NodeAssert.equal(mock.syntheticItems.size, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends upstream's delivery vocabulary, never the seam's", () =>
    Effect.gen(function* () {
      const { mock, synthetic, startThread } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-synthetic-delivery");
      yield* startThread(threadId);

      yield* synthetic.inject({ threadId, text: "queued", delivery: "follow-up" });
      yield* synthetic.inject({ threadId, text: "steered", delivery: "steer" });

      NodeAssert.deepEqual(
        mock.syntheticRequests.map((request) => request.delivery),
        ["queue", "steer"],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("only suppresses the wake when the caller asks it to", () =>
    Effect.gen(function* () {
      const { mock, synthetic, startThread } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-synthetic-resume");
      yield* startThread(threadId);

      // Session context: must not spend a model turn before the captain speaks.
      yield* synthetic.inject({
        threadId,
        text: "persona projection",
        delivery: "follow-up",
        resume: false,
      });
      // A delivered result is worthless if nobody reads it — keep the wake.
      yield* synthetic.inject({ threadId, text: "assignment result", delivery: "follow-up" });

      NodeAssert.deepEqual(
        mock.syntheticRequests.map((request) => request.resume),
        [false, undefined],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("renders an admitted synthetic item as a visible timeline row", () =>
    Effect.gen(function* () {
      const { adapter, synthetic, startThread } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-synthetic-visible");
      yield* startThread(threadId);

      const collected = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "item.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* synthetic.inject({
        threadId,
        text: "Coder finished: haiku written.",
        description: "ADE assignment results",
        delivery: "follow-up",
        dedupeKey: "delivery-key-visible",
      });

      const events = yield* Fiber.join(collected).pipe(Effect.timeout("5 seconds"));
      const event = [...events][0];
      NodeAssert.ok(event, "the admitted item must reach the timeline");
      NodeAssert.equal(event.type, "item.completed");
      if (event.type !== "item.completed") return;
      // Without this row the injected text is durable, is read by the model,
      // and is invisible to the captain.
      NodeAssert.equal(event.payload.itemType, "user_message");
      NodeAssert.equal(event.payload.detail, "Coder finished: haiku written.");
      NodeAssert.equal(event.payload.title, "ADE assignment results");
    }).pipe(Effect.provide(TestLayer)),
  );
});
