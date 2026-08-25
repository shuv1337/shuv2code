/**
 * Live wiring for the two {@link AdeVoiceChannel} seams (spec §4.7, S16).
 *
 * Kept out of `AdeVoiceChannel.ts` for the same reason `AdeApprovalPortLive`
 * is kept out of `AdeApprovalPort.ts`: the channel must stay importable by the
 * controller MCP surface without dragging the captain API — and its JJ repo
 * port, lease and queue — into that module graph.
 */
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { NeedsYouSubjectRef, type BotExecutionBindingId, type BotId } from "@shuv2code/contracts";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { AdeCaptainApi } from "./AdeCaptainApi.ts";
import { renderAdeToolOutcomeFailure } from "./AdeToolGate.ts";
import {
  AdeVoiceApprovalPort,
  AdeVoiceChannel,
  AdeVoiceSummaryEscalationPort,
  type AdeVoiceApprovalPortShape,
  type AdeVoiceCallNotFoundError,
  type AdeVoiceSummaryEscalationPortShape,
} from "./AdeVoiceChannel.ts";
import { AdeVoiceToolPlane, type AdeVoiceToolPlaneShape } from "./AdeVoiceToolPlane.ts";

/**
 * Verbal approvals ride the captain API verbatim — same projection, same
 * claim + forward + unclaim, same idempotency. The voice channel supplies the
 * `ade:approve`-gated channel and the two-phase token; it contributes nothing
 * to *how* a verdict is applied, which is the entire point of routing here.
 */
export const AdeVoiceApprovalPortLayerLive: Layer.Layer<
  AdeVoiceApprovalPort,
  never,
  AdeCaptainApi
> = Layer.effect(
  AdeVoiceApprovalPort,
  Effect.gen(function* () {
    const captain = yield* AdeCaptainApi;
    return {
      read: (needsYouItemId) => captain.getNeedsYouItem(needsYouItemId),
      submitDecision: (input) =>
        captain.submitNeedsYouDecision({
          needsYouItemId: input.needsYouItemId,
          decision: input.decision,
          ...(input.note === undefined ? {} : { note: input.note }),
        }),
    } satisfies AdeVoiceApprovalPortShape;
  }),
);

/**
 * The controller MCP surface's binding to the live channel. `catalogFor`
 * returning null for a non-ADE controller thread is the whole regression
 * guarantee: that path never reaches ADE code at all.
 */
export const AdeVoiceToolPlaneLayerLive: Layer.Layer<AdeVoiceToolPlane, never, AdeVoiceChannel> =
  Layer.effect(
    AdeVoiceToolPlane,
    Effect.gen(function* () {
      const channel = yield* AdeVoiceChannel;
      return {
        catalogFor: (controllerThreadId) =>
          Effect.map(channel.callByControllerThread(controllerThreadId), (call) =>
            call === null ? null : call.tools,
          ),
        dispatch: (input) =>
          Effect.gen(function* () {
            const call = yield* channel.callByControllerThread(input.controllerThreadId);
            if (call === null) {
              // The call ended between `tools/list` and `tools/call`. Refuse
              // rather than guess which bot this invocation belonged to.
              return {
                ok: false,
                message: `[ade:call-ended] The voice call for '${input.controllerThreadId}' is no longer live.`,
              } as const;
            }
            const outcome = yield* channel.dispatchTool({
              bindingId: call.bindingId,
              tool: input.tool,
              input: input.input,
              ...(input.callId === undefined ? {} : { callId: input.callId }),
            });
            return outcome._tag === "completed"
              ? ({ ok: true, content: outcome.content } as const)
              : ({ ok: false, message: renderAdeToolOutcomeFailure(outcome) } as const);
          }).pipe(
            Effect.catch((error: AdeVoiceCallNotFoundError) =>
              Effect.succeed({
                ok: false,
                message: `[ade:call-ended] ${error.message}`,
              } as const),
            ),
          ),
      } satisfies AdeVoiceToolPlaneShape;
    }),
  );

/** Deterministic id: one item per voice binding, so retries cannot pile up. */
export const undeliveredVoiceSummaryItemId = (bindingId: BotExecutionBindingId): string =>
  `voice-summary:${bindingId}`;

export const AdeVoiceSummaryEscalationPortLayerLive: Layer.Layer<
  AdeVoiceSummaryEscalationPort,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  AdeVoiceSummaryEscalationPort,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encodeSubjectRefs = Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(NeedsYouSubjectRef)),
    );

    const fileUndeliveredSummary: AdeVoiceSummaryEscalationPortShape["fileUndeliveredSummary"] =
      Effect.fn("AdeVoiceSummaryEscalationPort.fileUndeliveredSummary")(function* (input: {
        readonly botId: BotId;
        readonly bindingId: BotExecutionBindingId;
        readonly detail: string;
      }) {
        const at = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const itemId = undeliveredVoiceSummaryItemId(input.bindingId);
        const subjectRefs = yield* Effect.orDie(
          encodeSubjectRefs([{ _tag: "bot", botId: input.botId }]),
        );
        // Deduped on the primary key rather than by scanning subject blobs: a
        // fleet-wide kernel outage must produce one item per lost summary, not
        // one per sweep. The summary text is deliberately NOT inlined — it
        // lives on the binding row, and this item is the pointer to it.
        yield* sql`
          INSERT INTO ade_needs_you_items (
            needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
          ) VALUES (
            ${itemId}, 'stall', ${subjectRefs}, 'open', ${at}, ${at}, NULL
          )
          ON CONFLICT DO NOTHING
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("AdeVoiceSummaryEscalationPort.fileUndeliveredSummary"),
          ),
        );
        yield* Effect.logWarning("ADE voice call summary escalated to Needs You", {
          botId: input.botId,
          bindingId: input.bindingId,
          needsYouItemId: itemId,
          detail: input.detail,
        });
      });

    return { fileUndeliveredSummary } satisfies AdeVoiceSummaryEscalationPortShape;
  }),
);
