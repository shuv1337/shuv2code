import type {
  OrchestrationEvent,
  ProviderEffectOutcome,
  ProviderEffectOutcomeState,
  ThreadId,
} from "@shuv2code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { VoiceControllerMutationRepositoryShape } from "../persistence/Services/VoiceControllerMutations.ts";
import type { VoiceControllerMutation } from "../persistence/VoiceControlModels.ts";
import type { ProviderThreadSnapshot } from "../provider/Services/ProviderAdapter.ts";

const DEFAULT_PAGE_SIZE = 500;
type TerminalProviderEffectOutcomeState = Exclude<ProviderEffectOutcomeState, "pending">;
type TerminalProviderEffectOutcome = Omit<ProviderEffectOutcome, "state"> & {
  readonly state: TerminalProviderEffectOutcomeState;
};

export interface VoiceMutationOutcomeReconciliationResult {
  readonly recoverableCount: number;
  readonly eligibleCount: number;
  readonly matchedCount: number;
  readonly appliedCount: number;
  readonly scannedEvents: number;
  readonly upperBoundSequence: number;
  readonly authoritativeReadCount: number;
  readonly authoritativeAppliedCount: number;
}

export interface ReconcileVoiceMutationOutcomesInput {
  readonly engine: Pick<OrchestrationEngineShape, "latestSequence" | "readEvents">;
  readonly mutations: Pick<
    VoiceControllerMutationRepositoryShape,
    "listRecoverable" | "reconcilePersistedOutcome"
  >;
  /**
   * Reads provider-persisted history without replaying a provider mutation.
   * When omitted, reconciliation is limited to durable outcome events.
   */
  readonly readThread?: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, Error>;
  /**
   * Startup-only crash recovery. A fresh process has no live dispatcher that
   * can still own a durable claim, so claimed rows must be fenced rather than
   * replayed or left permanently claimed.
   */
  readonly includeClaimed?: boolean;
  readonly pageSize?: number;
}

function providerOutcome(event: OrchestrationEvent): ProviderEffectOutcome | null {
  if (event.type !== "thread.provider-effect-outcome-set") return null;
  return event.payload.outcome;
}

function terminalOutcome(outcome: ProviderEffectOutcome): TerminalProviderEffectOutcome | null {
  if (outcome.state === "pending") return null;
  return { ...outcome, state: outcome.state };
}

type AuthoritativeDecision = {
  readonly outcome: "confirmed" | "indeterminate" | "stale";
  readonly sanitizedCode: string;
};

function userMessageClientId(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const candidate = item as { readonly type?: unknown; readonly clientId?: unknown };
  return candidate.type === "userMessage" && typeof candidate.clientId === "string"
    ? candidate.clientId
    : undefined;
}

/**
 * The ADE voice catalog (spec §4.7, S16). These names can appear as the
 * `toolName` of a recovered controller mutation once a controller thread has
 * run as an ADE call, and they are **not** thread mutations: they do not go
 * through `ThreadControlExecutionCoordinator`, leave no `userMessage`
 * `clientId` in a provider turn, and mostly name no thread at all
 * (`fleet_read`, `update_memory`, the approval pair).
 *
 * Reconciling them against a provider thread snapshot is therefore not merely
 * unimplemented, it is meaningless — there is no provider-side evidence to
 * read. They are named here so that outcome is *stated* rather than falling
 * out of the generic "unsupported operation" path, which reads like a gap in
 * this reconciler when it is actually a different durability model: ADE tool
 * idempotency lives in the ADE engine (assignment `idempotencyKey`,
 * last-write-wins memory, and the single-use approval token).
 */
const ADE_VOICE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "fleet_read",
  "create_assignment",
  "steer_primary",
  "report_assignment_result",
  "update_memory",
  // `create_bot` carries its own durable replay key (migration 061), which is
  // exactly the durability model this set exists to name: a re-run resolves to
  // the bot the first call created rather than minting a twin.
  "create_bot",
  "prepare_approval",
  "commit_approval",
]);

export const isAdeVoiceToolName = (toolName: string): boolean => ADE_VOICE_TOOL_NAMES.has(toolName);

function mutationOperation(
  mutation: Pick<VoiceControllerMutation, "operationId" | "toolName">,
  persistedOutcome: ProviderEffectOutcome | undefined,
): "start" | "steer" | "interrupt" | undefined {
  if (persistedOutcome?.operation === "start") return "start";
  if (persistedOutcome?.operation === "steer") return "steer";
  if (persistedOutcome?.operation === "interrupt") return "interrupt";
  if (mutation.toolName === "thread_interrupt" && mutation.operationId.endsWith(":interrupt")) {
    return "interrupt";
  }
  if (mutation.toolName === "thread_send" && mutation.operationId.endsWith(":send-start")) {
    return "start";
  }
  if (mutation.toolName === "thread_send" && mutation.operationId.endsWith(":send-steer")) {
    return "steer";
  }
  return undefined;
}

function targetThreadId(
  mutation: Pick<VoiceControllerMutation, "semanticSlot" | "toolName">,
  persistedOutcome: ProviderEffectOutcome | undefined,
): ThreadId | undefined {
  if (persistedOutcome !== undefined) return persistedOutcome.threadId;
  if (mutation.toolName === "thread_send" && mutation.semanticSlot.startsWith("send:")) {
    const value = mutation.semanticSlot.slice("send:".length);
    return value.length > 0 ? (value as ThreadId) : undefined;
  }
  if (mutation.toolName === "thread_interrupt" && mutation.semanticSlot.startsWith("interrupt:")) {
    const value = mutation.semanticSlot.slice("interrupt:".length);
    const separator = value.lastIndexOf(":");
    return separator > 0 ? (value.slice(0, separator) as ThreadId) : undefined;
  }
  return undefined;
}

function expectedInterruptTurnId(
  mutation: Pick<VoiceControllerMutation, "semanticSlot" | "toolName">,
  persistedOutcome: ProviderEffectOutcome | undefined,
): string | undefined {
  if (persistedOutcome?.expectedTurnId != null) return persistedOutcome.expectedTurnId;
  if (mutation.toolName !== "thread_interrupt" || !mutation.semanticSlot.startsWith("interrupt:")) {
    return undefined;
  }
  const value = mutation.semanticSlot.slice("interrupt:".length);
  const separator = value.lastIndexOf(":");
  return separator > 0 ? value.slice(separator + 1) : undefined;
}

/**
 * Interpret only provider-authoritative facts. In particular, `turn/interrupt`
 * has no client operation id in the public protocol. An interrupted status is
 * therefore not proof that this specific call succeeded.
 */
export function classifyAuthoritativeVoiceMutation(input: {
  readonly mutation: Pick<VoiceControllerMutation, "operationId" | "toolName" | "semanticSlot">;
  readonly persistedOutcome?: ProviderEffectOutcome;
  readonly snapshot: ProviderThreadSnapshot;
}): AuthoritativeDecision {
  if (isAdeVoiceToolName(input.mutation.toolName)) {
    return {
      outcome: "indeterminate",
      sanitizedCode: "provider_reconciliation_ade_tool_not_thread_mutation",
    };
  }
  const operation = mutationOperation(input.mutation, input.persistedOutcome);
  if (operation === undefined) {
    return {
      outcome: "indeterminate",
      sanitizedCode: "provider_reconciliation_unsupported_operation",
    };
  }

  const expectedTurnId =
    operation === "interrupt"
      ? expectedInterruptTurnId(input.mutation, input.persistedOutcome)
      : (input.persistedOutcome?.expectedTurnId ?? undefined);
  const clientUserMessageId = `${input.mutation.operationId}:message`;
  const matchingTurns = input.snapshot.turns.filter((turn) =>
    turn.items.some((item) => userMessageClientId(item) === clientUserMessageId),
  );

  if (operation === "start") {
    return matchingTurns.length > 0
      ? { outcome: "confirmed", sanitizedCode: "provider_message_id_observed" }
      : { outcome: "indeterminate", sanitizedCode: "provider_message_id_not_observed" };
  }

  if (operation === "steer") {
    if (
      matchingTurns.length > 0 &&
      (expectedTurnId === undefined || matchingTurns.some((turn) => turn.id === expectedTurnId))
    ) {
      return { outcome: "confirmed", sanitizedCode: "provider_message_id_observed" };
    }
    if (matchingTurns.length > 0) {
      return { outcome: "stale", sanitizedCode: "provider_message_turn_mismatch" };
    }
    const expectedTurn = input.snapshot.turns.find((turn) => turn.id === expectedTurnId);
    if (
      expectedTurn?.itemsView === "full" &&
      (expectedTurn.status === "completed" ||
        expectedTurn.status === "failed" ||
        expectedTurn.status === "interrupted")
    ) {
      return { outcome: "stale", sanitizedCode: "provider_steer_target_terminal_without_message" };
    }
    return {
      outcome: "indeterminate",
      sanitizedCode:
        expectedTurnId === undefined
          ? "provider_steer_target_identity_unavailable"
          : "provider_steer_outcome_unproven",
    };
  }

  if (expectedTurnId === undefined) {
    return {
      outcome: "indeterminate",
      sanitizedCode: "provider_interrupt_target_identity_unavailable",
    };
  }
  const expectedTurn = input.snapshot.turns.find((turn) => turn.id === expectedTurnId);
  if (expectedTurn?.status === "completed" || expectedTurn?.status === "failed") {
    return { outcome: "stale", sanitizedCode: "provider_interrupt_target_completed" };
  }
  return {
    outcome: "indeterminate",
    sanitizedCode:
      expectedTurn?.status === "interrupted"
        ? "provider_interrupt_identity_unavailable"
        : "provider_interrupt_outcome_unproven",
  };
}

export const reconcileVoiceMutationOutcomes = Effect.fn("VoiceMutationOutcomeReconciler.reconcile")(
  function* ({
    engine,
    mutations,
    readThread,
    includeClaimed = false,
    pageSize = DEFAULT_PAGE_SIZE,
  }: ReconcileVoiceMutationOutcomesInput) {
    const recoverable = yield* mutations.listRecoverable();
    const eligible = recoverable.filter(
      (mutation) =>
        (includeClaimed && mutation.dispatchState === "claimed") ||
        mutation.dispatchState === "dispatched" ||
        mutation.dispatchState === "indeterminate",
    );
    const upperBoundSequence = yield* engine.latestSequence;
    if (eligible.length === 0) {
      return {
        recoverableCount: recoverable.length,
        eligibleCount: eligible.length,
        matchedCount: 0,
        appliedCount: 0,
        scannedEvents: 0,
        upperBoundSequence,
        authoritativeReadCount: 0,
        authoritativeAppliedCount: 0,
      } satisfies VoiceMutationOutcomeReconciliationResult;
    }

    const normalizedPageSize = Math.max(1, Math.min(1_000, Math.floor(pageSize)));
    const wantedOperationIds = new Set(eligible.map((mutation) => mutation.operationId));
    const latestOutcomeByOperation = new Map<string, TerminalProviderEffectOutcome>();
    const latestProviderOutcomeByOperation = new Map<string, ProviderEffectOutcome>();
    let cursor = 0;
    let scannedEvents = 0;
    let remainingPages = Math.ceil(upperBoundSequence / normalizedPageSize) + 1;

    while (cursor < upperBoundSequence && remainingPages > 0) {
      const page = Array.from(
        yield* engine.readEvents(cursor, normalizedPageSize).pipe(Stream.runCollect),
      );
      if (page.length === 0) break;
      remainingPages -= 1;

      for (const event of page) {
        cursor = Math.max(cursor, event.sequence);
        if (event.sequence > upperBoundSequence) continue;
        scannedEvents += 1;
        const persistedOutcome = providerOutcome(event);
        if (persistedOutcome !== null && wantedOperationIds.has(persistedOutcome.operationId)) {
          latestProviderOutcomeByOperation.set(persistedOutcome.operationId, persistedOutcome);
          const outcome = terminalOutcome(persistedOutcome);
          if (outcome !== null) {
            latestOutcomeByOperation.set(outcome.operationId, outcome);
          }
        }
      }
    }

    let appliedCount = 0;
    for (const mutation of eligible) {
      const outcome = latestOutcomeByOperation.get(mutation.operationId);
      if (outcome === undefined) continue;
      const applied = yield* mutations.reconcilePersistedOutcome({
        operationId: mutation.operationId,
        outcome: outcome.state,
        providerAcknowledgedAt: outcome.state === "confirmed" ? outcome.updatedAt : null,
        outcomeAt: outcome.updatedAt,
        sanitizedOutcome: outcome.sanitizedCode.slice(0, 512),
      });
      if (applied) appliedCount += 1;
    }

    let authoritativeReadCount = 0;
    let authoritativeAppliedCount = 0;
    if (readThread !== undefined) {
      for (const mutation of eligible) {
        if (latestOutcomeByOperation.has(mutation.operationId)) continue;
        const persistedOutcome = latestProviderOutcomeByOperation.get(mutation.operationId);
        const threadId = targetThreadId(mutation, persistedOutcome);
        const operation = mutationOperation(mutation, persistedOutcome);
        if (
          threadId === undefined ||
          operation === undefined ||
          (operation === "steer" && persistedOutcome === undefined)
        ) {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);
          const applied = yield* mutations.reconcilePersistedOutcome({
            operationId: mutation.operationId,
            outcome: "indeterminate",
            providerAcknowledgedAt: null,
            outcomeAt: reconciledAt,
            sanitizedOutcome: "provider_reconciliation_evidence_unavailable",
          });
          if (applied) authoritativeAppliedCount += 1;
          continue;
        }
        authoritativeReadCount += 1;
        const snapshot = yield* readThread(threadId).pipe(Effect.option);
        const reconciledAt = DateTime.formatIso(yield* DateTime.now);
        const decision =
          snapshot._tag === "Some"
            ? classifyAuthoritativeVoiceMutation({
                mutation,
                ...(persistedOutcome === undefined ? {} : { persistedOutcome }),
                snapshot: snapshot.value,
              })
            : {
                outcome: "indeterminate" as const,
                sanitizedCode: "provider_reconciliation_read_failed",
              };
        const applied = yield* mutations.reconcilePersistedOutcome({
          operationId: mutation.operationId,
          outcome: decision.outcome,
          providerAcknowledgedAt: decision.outcome === "confirmed" ? reconciledAt : null,
          outcomeAt: reconciledAt,
          sanitizedOutcome: decision.sanitizedCode,
        });
        if (applied) authoritativeAppliedCount += 1;
      }
    } else {
      for (const mutation of eligible) {
        if (
          mutation.dispatchState !== "claimed" ||
          latestOutcomeByOperation.has(mutation.operationId)
        ) {
          continue;
        }
        const reconciledAt = DateTime.formatIso(yield* DateTime.now);
        const applied = yield* mutations.reconcilePersistedOutcome({
          operationId: mutation.operationId,
          outcome: "indeterminate",
          providerAcknowledgedAt: null,
          outcomeAt: reconciledAt,
          sanitizedOutcome: "provider_reconciliation_evidence_unavailable",
        });
        if (applied) authoritativeAppliedCount += 1;
      }
    }

    return {
      recoverableCount: recoverable.length,
      eligibleCount: eligible.length,
      matchedCount: latestOutcomeByOperation.size,
      appliedCount,
      scannedEvents,
      upperBoundSequence,
      authoritativeReadCount,
      authoritativeAppliedCount,
    } satisfies VoiceMutationOutcomeReconciliationResult;
  },
);
