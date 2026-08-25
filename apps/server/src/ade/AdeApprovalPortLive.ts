/**
 * Live {@link AdeApprovalPort}: the captain's verdict, handed to the service
 * that owns the candidate state machine (spec §4.4).
 *
 * Kept out of `AdeApprovalPort.ts` so the port stays importable — by the
 * captain API and by its tests — without dragging the integration service,
 * its JJ repo port, and its process runner along with it.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AdeCaptainError } from "@shuv2code/contracts";

import { AdeApprovalPort, type AdeApprovalPortShape } from "./AdeApprovalPort.ts";
import { AdeIntegrationService } from "./AdeIntegrationService.ts";

/**
 * Every failure the integration service can produce here means the same thing
 * to the captain: the verdict did not land. `AdeIntegrationCandidateStateError`
 * in particular is the benign case — someone else already decided — and the
 * inbox turns it back into `needs_you_already_resolved` by re-reading the item.
 */
const rejected = (message: string) =>
  new AdeCaptainError({ reason: "needs_you_decision_rejected", message });

export const AdeApprovalPortLayerLive: Layer.Layer<AdeApprovalPort, never, AdeIntegrationService> =
  Layer.effect(
    AdeApprovalPort,
    Effect.gen(function* () {
      const integration = yield* AdeIntegrationService;
      return {
        submitIntegrationApproval: (input) =>
          integration
            .submitApproval({
              candidateId: input.candidateId,
              decision: input.decision,
              ...(input.note === undefined ? {} : { note: input.note }),
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("AdeIntegrationCandidateStateError", (error) =>
                Effect.fail(
                  rejected(
                    `Candidate ${error.candidateId} is ${error.actual}, not awaiting approval.`,
                  ),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.fail(rejected(`The approval could not be applied: ${String(cause)}`)),
              ),
            ),
      } satisfies AdeApprovalPortShape;
    }),
  );
