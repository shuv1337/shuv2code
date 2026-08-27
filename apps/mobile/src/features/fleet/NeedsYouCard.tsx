/**
 * One Needs You item on a phone (spec §7 slice 5).
 *
 * "One durable item, two renderings" is a claim about *resolution*: this card
 * and the web one send the same `ade.submitNeedsYouDecision` for the same id
 * through the same shared decision view, so an item retires exactly once no
 * matter which device the captain used. Only the markup differs.
 *
 * A phone adds one case web mostly does not have: a client that legitimately
 * cannot approve. `ade:approve` is excluded from the standard client scopes a
 * paired phone requests, so the honest rendering is the item in full with the
 * controls replaced by the reason — never a hidden item, and never buttons that
 * would fail.
 */
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { adeCaptainErrorMessage, adeCaptainErrorReason } from "@shuv2code/client-runtime/ade/logic";
import {
  describeDecisionOutcome,
  getNeedsYouDecisionView,
  needsYouKindLabel,
} from "@shuv2code/client-runtime/ade/needs-you";
import type { AdeNeedsYouEntry, EnvironmentId, NeedsYouDecision } from "@shuv2code/contracts";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { adeEnvironment } from "../../state/ade";
import { useAtomCommand } from "../../state/use-atom-command";
import { MOBILE_APPROVE_UNAVAILABLE_REASON } from "./needsYou.logic";

export function NeedsYouCard(props: {
  readonly entry: AdeNeedsYouEntry;
  readonly environmentId: EnvironmentId;
  readonly canApprove: boolean;
}) {
  const submit = useAtomCommand(adeEnvironment.submitNeedsYouDecision, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReturnType<typeof describeDecisionOutcome> | null>(null);

  const decisionView = getNeedsYouDecisionView({
    entry: props.entry,
    canApprove: props.canApprove,
    busy,
    unscopedReason: MOBILE_APPROVE_UNAVAILABLE_REASON,
  });

  const decide = async (decision: NeedsYouDecision) => {
    setBusy(true);
    setOutcome(null);
    const result = await submit({
      environmentId: props.environmentId,
      input: { needsYouItemId: props.entry.item.id, decision },
    });
    setBusy(false);
    const failed = result._tag === "Failure";
    const squashed = failed ? squashAtomCommandFailure(result) : null;
    setOutcome(
      describeDecisionOutcome({
        decision,
        failed,
        reason: adeCaptainErrorReason(squashed),
        fallback: adeCaptainErrorMessage(squashed, "That decision could not be applied."),
      }),
    );
  };

  const open = props.entry.item.status === "open";

  return (
    <View
      className={`gap-2 rounded-[22px] border border-border bg-card p-4 ${open ? "" : "opacity-70"}`}
    >
      <View className="flex-row items-center gap-2">
        <View
          className={`rounded-full px-2 py-0.5 ${
            props.entry.actionable ? "bg-danger" : "bg-card-alt"
          }`}
        >
          <Text
            className={`text-xs font-shuv2code-bold uppercase tracking-wide ${
              props.entry.actionable ? "text-danger-foreground" : "text-foreground-muted"
            }`}
          >
            {needsYouKindLabel(props.entry.item.kind)}
          </Text>
        </View>
        {open ? null : <Text className="text-xs text-foreground-tertiary">Resolved</Text>}
      </View>
      <Text className="text-base font-shuv2code-bold text-foreground">{props.entry.title}</Text>
      <Text className="text-sm leading-relaxed text-foreground-muted">{props.entry.detail}</Text>

      {decisionView.canDecide || busy ? (
        <View className="mt-1 flex-row items-center gap-2">
          {busy ? <ActivityIndicator /> : null}
          {decisionView.action === "acknowledge" ? (
            /* Nothing is waiting on a verdict; the captain is retiring an item
               no service will ever clear on its own. */
            <DecisionButton
              busy={busy}
              label="Acknowledge"
              onPress={() => void decide("acknowledge")}
              tone="neutral"
            />
          ) : (
            <>
              <DecisionButton
                busy={busy}
                label="Approve"
                onPress={() => void decide("approve")}
                tone="primary"
              />
              <DecisionButton
                busy={busy}
                label="Deny"
                onPress={() => void decide("deny")}
                tone="neutral"
              />
            </>
          )}
        </View>
      ) : decisionView.unavailableReason === null ? null : (
        <Text className="text-xs leading-relaxed text-foreground-tertiary">
          {decisionView.unavailableReason}
        </Text>
      )}

      {outcome === null ? null : (
        <Text
          accessibilityLiveRegion={outcome.tone === "error" ? "assertive" : "polite"}
          className={`text-xs ${
            outcome.tone === "error" ? "text-danger-foreground" : "text-foreground-muted"
          }`}
        >
          {outcome.message}
        </Text>
      )}
    </View>
  );
}

function DecisionButton(props: {
  readonly busy: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone: "primary" | "neutral";
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.busy }}
      className={`rounded-full px-4 py-2 active:opacity-70 ${
        props.tone === "primary" ? "bg-primary" : "bg-card-alt"
      } ${props.busy ? "opacity-50" : ""}`}
      disabled={props.busy}
      onPress={props.onPress}
    >
      <Text
        className={`text-sm font-shuv2code-bold ${
          props.tone === "primary" ? "text-primary-foreground" : "text-foreground"
        }`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
