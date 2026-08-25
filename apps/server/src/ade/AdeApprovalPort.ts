/**
 * ADE approval port (spec `docs/ade/ADE-V1-SPEC.md` §7 slice 5, §4.4).
 *
 * A Needs You `approval` item is a *pointer*: the durable decision it records
 * belongs to whichever service parked work on the captain. Today that is the
 * integration service — an `awaiting-approval` candidate — so the inbox's job
 * ends at "resolve the item and hand the verdict to its owner".
 *
 * This is a port rather than a direct dependency on `AdeIntegrationService`
 * for the same reason {@link AdeChatSessionPort} is: everything else the
 * captain API does is persistence against the ADE tables, while this reaches
 * into a service that carries a JJ repo port, a lease, and a whole queue. The
 * seam also keeps the inbox honest — it can render and resolve items in builds
 * where integration is not wired at all.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AdeCaptainError,
  type IntegrationCandidateId,
  type NeedsYouDecision,
} from "@shuv2code/contracts";

export interface AdeApprovalPortShape {
  /**
   * Apply the captain's verdict to an integration candidate parked on
   * `awaiting-approval`. Failing means the verdict did *not* land, and the
   * inbox reopens the item rather than quietly swallowing the decision.
   */
  readonly submitIntegrationApproval: (input: {
    readonly candidateId: IntegrationCandidateId;
    readonly decision: NeedsYouDecision;
    readonly note?: string;
  }) => Effect.Effect<void, AdeCaptainError>;
}

/**
 * Default when integration is not wired. Reads still work; a decision fails
 * loudly instead of resolving an item whose subject nothing acted on.
 */
export const adeApprovalPortUnavailable: AdeApprovalPortShape = {
  submitIntegrationApproval: () =>
    Effect.fail(
      new AdeCaptainError({
        reason: "needs_you_decision_rejected",
        message: "No integration service is wired to receive this approval in this build.",
      }),
    ),
};

export class AdeApprovalPort extends Context.Service<AdeApprovalPort, AdeApprovalPortShape>()(
  "shuv2code/ade/AdeApprovalPort",
) {
  static readonly layerUnavailable = Layer.succeed(AdeApprovalPort, adeApprovalPortUnavailable);
}
