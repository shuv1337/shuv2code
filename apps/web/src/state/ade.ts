import type {
  AdeAssignmentGraph,
  AdeBotDetail,
  AdeBotGroup,
  AdeBotScreen,
  AdeNeedsYouCount,
  AdeNeedsYouEntry,
  AdeNeedsYouList,
  AdeProjectCandidates,
  AdeProjectDetail,
  AdeProjectId,
  AdePublicationStackView,
  PublicationStackId,
  AdeRoster,
  BotId,
  FleetHealthSnapshot,
  NeedsYouItemId,
} from "@shuv2code/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@shuv2code/client-runtime/connection";
import { createAdeEnvironmentAtoms } from "@shuv2code/client-runtime/state/ade";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { fleetHealthForConnectionPhase } from "./ade.logic";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";

export const adeEnvironment = createAdeEnvironmentAtoms(connectionAtomRuntime);

/**
 * Latest fleet health pushed by the primary environment's health checker
 * (spec §4.8); null before the first snapshot arrives, when disconnected, or
 * while reconnecting — the pills render every target as `unknown` then.
 */
export const primaryFleetHealthAtom = Atom.make((get): FleetHealthSnapshot | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  const connection = Option.getOrElse(
    AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const snapshot = Option.getOrNull(
    AsyncResult.value(get(adeEnvironment.fleetHealth({ environmentId, input: {} }))),
  );
  return fleetHealthForConnectionPhase(connection.phase, snapshot);
}).pipe(Atom.withLabel("web-primary-ade-fleet-health"));

/**
 * The ADE fleet lives on the primary environment only: bots, assignments and
 * memory are server-local records, and a captain surface pointed at a second
 * server would be reading a different fleet entirely.
 */
export function useAdeEnvironmentId() {
  return useAtomValue(primaryEnvironmentIdAtom);
}

/** The captain's roster (UI slice 2); null data until the primary answers. */
export function useAdeRoster(): EnvironmentQueryView<AdeRoster> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.roster({ environmentId, input: {} }),
  );
}

/**
 * The captain's contact groups (messenger pivot §4). Read off the roster
 * rather than through a second RPC: groups and the bots filed into them have
 * to agree, and two independent reads is how a rail ends up rendering a header
 * whose members it has not heard about yet.
 */
export function useAdeBotGroups(): ReadonlyArray<AdeBotGroup> {
  return useAdeRoster().data?.groups ?? EMPTY_BOT_GROUPS;
}

/** Stable identity so an empty roster does not re-render every consumer. */
const EMPTY_BOT_GROUPS: ReadonlyArray<AdeBotGroup> = [];

/**
 * One bot's desktop state for the Screen tab (spec §4.6).
 *
 * A null `botId` reads nothing, which is what keeps the poll — and therefore
 * the desktop status lookup — off entirely while the tab is not open.
 */
export function useAdeBotScreen(botId: BotId | null): EnvironmentQueryView<AdeBotScreen> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || botId === null
      ? null
      : adeEnvironment.botScreen({ environmentId, input: { botId } }),
  );
}

/** One bot's detail (UI slice 2). A null `botId` reads nothing. */
export function useAdeBotDetail(botId: BotId | null): EnvironmentQueryView<AdeBotDetail> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || botId === null
      ? null
      : adeEnvironment.bot({ environmentId, input: { botId } }),
  );
}

/** Project header + crew panel (UI slice 3). A null `projectId` reads nothing. */
export function useAdeProject(
  projectId: AdeProjectId | null,
): EnvironmentQueryView<AdeProjectDetail> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : adeEnvironment.project({ environmentId, input: { projectId } }),
  );
}

/**
 * The project's integration queue (UI slice 3, panel 2). Status filtering is
 * deliberately client-side — the chips have to show how many candidates each
 * status holds, which a server-filtered list cannot answer.
 */
export function useAdeProjectCandidates(
  projectId: AdeProjectId | null,
): EnvironmentQueryView<AdeProjectCandidates> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : adeEnvironment.projectCandidates({ environmentId, input: { projectId } }),
  );
}

/** The project's publication stack and layers (UI slice 3, panel 3). */
export function useAdeProjectPublicationStack(
  projectId: AdeProjectId | null,
): EnvironmentQueryView<AdePublicationStackView | null> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : adeEnvironment.projectPublicationStack({ environmentId, input: { projectId } }),
  );
}

/**
 * One publication stack by its own id (MESSENGER-PIVOT §6 M5).
 *
 * `null` reads nothing and starts no poller, which is what lets a `PrResultCard`
 * mount unconditionally in a conversation and only fetch when the delivery it
 * renders actually named a stack.
 */
export function useAdePublicationStack(
  stackId: PublicationStackId | null,
): EnvironmentQueryView<AdePublicationStackView | null> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || stackId === null
      ? null
      : adeEnvironment.publicationStack({ environmentId, input: { stackId } }),
  );
}

/** Assignment lineage for the work graph (UI slice 4); null scope is fleet-wide. */
export function useAdeAssignmentGraph(
  projectId: AdeProjectId | null,
): EnvironmentQueryView<AdeAssignmentGraph> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : adeEnvironment.assignmentGraph({ environmentId, input: { projectId } }),
  );
}

/** Sidebar "Needs You" badge count (UI slice 8), polled by the query atom. */
export function useAdeNeedsYouCount(): EnvironmentQueryView<AdeNeedsYouCount> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.needsYouCount({ environmentId, input: {} }),
  );
}

/**
 * The Needs You inbox (UI slice 5). The same list backs both renderings: the
 * dedicated inbox reads all of it, and the inline rendering filters it by
 * subject. One durable item, one client read, two places it shows up.
 */
export function useAdeNeedsYouList(
  options: { readonly includeResolved?: boolean } = {},
): EnvironmentQueryView<AdeNeedsYouList> {
  const environmentId = useAdeEnvironmentId();
  const includeResolved = options.includeResolved ?? false;
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : adeEnvironment.needsYou({ environmentId, input: { includeResolved } }),
  );
}

/** One item, for the inbox detail pane. A null id reads nothing. */
export function useAdeNeedsYouItem(
  needsYouItemId: NeedsYouItemId | null,
): EnvironmentQueryView<AdeNeedsYouEntry> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || needsYouItemId === null
      ? null
      : adeEnvironment.needsYouItem({ environmentId, input: { needsYouItemId } }),
  );
}
