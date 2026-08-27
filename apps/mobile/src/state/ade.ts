/**
 * ADE ("bot mode") client state for mobile.
 *
 * Deliberately thin: `createAdeEnvironmentAtoms` in
 * `@shuv2code/client-runtime/state/ade` already owns every ADE read, write and
 * subscription, and the web captain surface consumes the same factory. This
 * module only binds it to mobile's connection runtime and answers the one
 * question mobile has to answer differently — *which* environment the fleet
 * lives on.
 *
 * Web keys that on `PrimaryConnectionTarget`, which mobile never mints (it
 * pairs over Bearer/Relay), so `primaryEnvironmentIdAtom` is permanently null
 * here. The mobile answer is the environment the workspace is already looking
 * at: Home's environment filter when the captain has set one, otherwise the
 * connected environment. See `resolveAdeEnvironmentId`.
 */
import type {
  AdeBotDetail,
  AdeBotScreen,
  AdeNeedsYouCount,
  AdeNeedsYouList,
  AdeRoster,
  AuthSessionState,
  BotId,
  EnvironmentId,
  FleetHealthSnapshot,
  HealthState,
} from "@shuv2code/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createAdeEnvironmentAtoms } from "@shuv2code/client-runtime/state/ade";
import { fleetHealthForConnectionPhase } from "@shuv2code/client-runtime/ade/logic";
import { getBotModelOptions, type BotModelOption } from "@shuv2code/client-runtime/ade/bot-model";
import { canApproveWithSession } from "@shuv2code/client-runtime/ade/needs-you";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";
import { environmentSession } from "./session";
import { serverEnvironment } from "./server";

export const adeEnvironment = createAdeEnvironmentAtoms(connectionAtomRuntime);

/** The captain's roster, live. A null environment reads nothing. */
export function useAdeRoster(environmentId: EnvironmentId | null): EnvironmentQueryView<AdeRoster> {
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.roster({ environmentId, input: {} }),
  );
}

/** One bot's detail. A null `botId` (or environment) reads nothing. */
export function useAdeBotDetail(
  environmentId: EnvironmentId | null,
  botId: BotId | null,
): EnvironmentQueryView<AdeBotDetail> {
  return useEnvironmentQuery(
    environmentId === null || botId === null
      ? null
      : adeEnvironment.bot({ environmentId, input: { botId } }),
  );
}

/** The "Needs You" badge count. PASS 1 shows the number and nothing else. */
export function useAdeNeedsYouCount(
  environmentId: EnvironmentId | null,
): EnvironmentQueryView<AdeNeedsYouCount> {
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.needsYouCount({ environmentId, input: {} }),
  );
}

/**
 * Latest fleet health for one environment, or null while the connection is
 * anything but live — stale health is worse than no health, which is the rule
 * `fleetHealthForConnectionPhase` exists to state once for every client.
 */
export function useAdeFleetHealth(environmentId: EnvironmentId | null): FleetHealthSnapshot | null {
  const connection = useEnvironmentQuery(
    environmentId === null ? null : environmentCatalog.stateAtom(environmentId),
  );
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.fleetHealth({ environmentId, input: {} }),
  );
  return fleetHealthForConnectionPhase(connection.data?.phase ?? "available", snapshot.data);
}

/**
 * The shuvcode kernel's health, which is what decides whether opening a
 * conversation may attempt a session at all (`canAutoConnect`).
 */
export function useAdeKernelHealth(environmentId: EnvironmentId | null): HealthState | null {
  const health = useAdeFleetHealth(environmentId);
  return health?.targets.find((target) => target.target === "shuvcode")?.state ?? null;
}

/**
 * The Needs You inbox (spec §7 slice 5).
 *
 * One read backs the list and the badge alike — the payload carries `open`
 * beside `entries` for exactly that reason — so the number on the pill and the
 * number of rows behind it cannot disagree by a poll interval.
 */
export function useAdeNeedsYouList(
  environmentId: EnvironmentId | null,
  options: { readonly includeResolved?: boolean } = {},
): EnvironmentQueryView<AdeNeedsYouList> {
  const includeResolved = options.includeResolved ?? false;
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : adeEnvironment.needsYou({ environmentId, input: { includeResolved } }),
  );
}

/**
 * One bot's desktop state (spec §4.6). A null `botId` reads nothing, which is
 * what keeps the 5s poll — and with it the upstream status lookup — off while
 * no profile is open.
 */
export function useAdeBotScreen(
  environmentId: EnvironmentId | null,
  botId: BotId | null,
): EnvironmentQueryView<AdeBotScreen> {
  return useEnvironmentQuery(
    environmentId === null || botId === null
      ? null
      : adeEnvironment.botScreen({ environmentId, input: { botId } }),
  );
}

/**
 * Whether this phone's pairing carries `ade:approve` (spec §5).
 *
 * Read from the server's own `/api/auth/session`, not from the scope array the
 * app asks for at pairing time. Those are different facts: `ClientPresentation`
 * requests {@link AuthStandardClientScopes}, which deliberately excludes
 * approval, but a phone paired through an administrative link holds more — and
 * a hardcoded "phones cannot approve" would hide the buttons from a captain who
 * demonstrably can. `canApproveWithSession` also settles the unresolved case:
 * positive knowledge only, so a session that has not answered yet leaves the
 * controls up and lets the server's typed refusal be the authority.
 */
export function useAdeCanApprove(environmentId: EnvironmentId | null): boolean {
  const session = useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateValueAtom(environmentId),
  );
  return canApproveWithSession(session);
}

const EMPTY_SESSION_STATE_ATOM = Atom.make<AuthSessionState | null>(null).pipe(
  Atom.withLabel("mobile-ade-session-state:empty"),
);

/**
 * Every shuvcode model this environment can pin a bot to, capable ones first.
 *
 * Empty until the server config lands, which is the honest answer: a picker
 * that renders "Kernel default" and nothing else is telling the captain the
 * kernel has no catalog, and an empty list plus the sheet's own copy says the
 * same thing without asserting it.
 */
export function useAdeBotModelOptions(
  environmentId: EnvironmentId | null,
): ReadonlyArray<BotModelOption> {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return useMemo(() => getBotModelOptions(config?.providers ?? []), [config]);
}
