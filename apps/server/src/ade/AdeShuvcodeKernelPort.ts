/**
 * Live shuvcode `AdeAssignmentKernelPort` (spec §3.4, §4.2; issue #163).
 *
 * S7 built exactly-once delivery down to a port boundary and shipped it
 * unwired; this is the shuvcode half of that boundary. Delivery and steering
 * both ride the synthetic-input seam — the difference is `delivery`, which is
 * the ADR §13 steer-vs-cancel distinction made concrete: results are
 * `follow-up` (queued behind whatever the bot is doing), steering is `steer`
 * (folded into the running turn). Neither ever interrupts.
 *
 * `deliveryKey` is forwarded as the seam's dedupe key so a crash-window replay
 * is recognizable kernel-side as well as in ADE's own durable claim.
 *
 * Codex delivery (`thread/inject_items`) is deliberately **not** wired here:
 * S9's milestone runs on shuvcode (spec §1 — the primary kernel for all text
 * work), and Codex sessions additionally need the shared-topology config that
 * lands with the coordinator specialized-session work. A Codex batch fails
 * typed, so the engine retains its claim and redelivers rather than dropping
 * it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BotId, KernelEngine } from "@shuv2code/contracts";

import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import {
  AdeAssignmentKernelPort,
  AdeAssignmentKernelPortError,
  type AdeAssignmentKernelPortShape,
} from "./AdeAssignmentEngine.ts";
import { AdeHealthChecker } from "./AdeHealthChecker.ts";
import { ADE_SHUVCODE_INSTANCE_ID, adeBotThreadId } from "./AdeShuvcodeChatSession.ts";

const notWired = (operation: "deliverResults" | "steerPrimary", detail: string) =>
  new AdeAssignmentKernelPortError({ operation, detail });

export class AdeShuvcodeKernelPort extends Context.Service<
  AdeShuvcodeKernelPort,
  AdeAssignmentKernelPortShape
>()("shuv2code/ade/AdeShuvcodeKernelPort") {
  static readonly layer: Layer.Layer<
    AdeAssignmentKernelPort,
    never,
    AdeHealthChecker | ProviderAdapterRegistry.ProviderAdapterRegistry | SqlClient.SqlClient
  > = Layer.effect(
    AdeAssignmentKernelPort,
    Effect.gen(function* () {
      const checker = yield* AdeHealthChecker;
      const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const sql = yield* SqlClient.SqlClient;

      /** The synthetic-input seam, or null when shuvcode is not routable. */
      const seam = Effect.orElseSucceed(
        Effect.map(
          adapters.getByInstance(ADE_SHUVCODE_INSTANCE_ID),
          (adapter) => adapter.syntheticInput ?? null,
        ),
        () => null,
      );

      /**
       * Bindings record the kernel-native session id, while the seam is keyed
       * by thread. The binding row is the only place that join lives.
       */
      const botForSession = (sessionId: string) =>
        Effect.orElseSucceed(
          Effect.map(
            sql<{ bot_id: string }>`
              SELECT bot_id FROM ade_bot_execution_bindings
              WHERE engine = 'shuvcode' AND kernel_session_id = ${sessionId}
            `,
            (rows) => (rows[0]?.bot_id ?? null) as BotId | null,
          ),
          () => null,
        );

      const inject = (input: {
        readonly operation: "deliverResults" | "steerPrimary";
        readonly engine: KernelEngine;
        readonly botId: BotId;
        readonly text: string;
        readonly description: string;
        readonly delivery: "follow-up" | "steer";
        readonly dedupeKey?: string;
      }) =>
        Effect.gen(function* () {
          if (input.engine !== "shuvcode") {
            return yield* notWired(
              input.operation,
              `the ${input.engine} kernel has no ADE delivery port in this build`,
            );
          }
          const synthetic = yield* seam;
          if (synthetic === null) {
            return yield* notWired(input.operation, "the shuvcode adapter is not routable");
          }
          yield* synthetic
            .inject({
              threadId: adeBotThreadId(input.botId),
              text: input.text,
              description: input.description,
              delivery: input.delivery,
              ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
            })
            .pipe(
              Effect.mapError((cause) =>
                notWired(input.operation, cause instanceof Error ? cause.message : String(cause)),
              ),
            );
        });

      return AdeAssignmentKernelPort.of({
        // `unknown` (pre-first-probe) and `not-provisioned` are not outages;
        // only `down` refuses admission (ADR §11.3 queue-and-alert).
        kernelHealth: (engine: KernelEngine) =>
          Effect.map(checker.latest, (snapshot) => {
            const target = snapshot.targets.find((entry) => entry.target === engine);
            return target?.state === "down"
              ? ({ available: false, detail: target.detail ?? `${engine} is down` } as const)
              : ({ available: true } as const);
          }),

        deliverResults: (batch) =>
          inject({
            operation: "deliverResults",
            engine: batch.engine,
            botId: batch.targetBotId,
            text: batch.text,
            description: batch.redelivery
              ? "ADE assignment results (redelivery)"
              : "ADE assignment results",
            delivery: "follow-up",
            dedupeKey: batch.deliveryKey,
          }),

        steerPrimary: (input) =>
          inject({
            operation: "steerPrimary",
            engine: input.engine,
            botId: input.botId,
            text: input.text,
            description: "ADE steer",
            delivery: "steer",
          }),

        // Adoption after a restart is only safe while this process still holds
        // the session; a stale row must take the conservative `needs-resume`
        // path instead (ADR §16).
        isSessionLive: (input) =>
          input.engine !== "shuvcode"
            ? Effect.succeed(false)
            : Effect.gen(function* () {
                const synthetic = yield* seam;
                if (synthetic === null) return false;
                const botId = yield* botForSession(input.sessionId);
                if (botId === null) return false;
                return yield* synthetic.isLive(adeBotThreadId(botId));
              }),
      });
    }),
  );
}
