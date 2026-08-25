/**
 * ADE client state (spec `docs/ade/ADE-V1-SPEC.md` §4.8, §7.8): the fleet
 * health subscription backing the sidebar kernel pills, plus the S9 captain
 * skeleton reads and writes (UI slices 1, 2, 8) — roster, bot detail, the
 * Needs You badge count, and the five captain mutations — plus the S12
 * project-view and work-graph reads (slices 3, 4).
 */
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { WS_METHODS, type BotId, type EnvironmentId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createAdeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();

  /**
   * The captain's crew list. Cheap enough to re-read on focus, but there is no
   * roster stream yet, so a slow poll keeps a left-open list from going stale.
   */
  const roster = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:roster",
    tag: WS_METHODS.adeGetRoster,
    staleTimeMs: 2_000,
    refreshIntervalMs: 15_000,
  });

  /** One bot's bindings, memory, persona history and open assignments. */
  const bot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:bot",
    tag: WS_METHODS.adeGetBot,
    staleTimeMs: 2_000,
    refreshIntervalMs: 15_000,
  });

  /**
   * Sidebar "Needs You" badge. No stream backs it (spec §7.8 slice 8), so the
   * count is polled — slowly, because it is a badge and not a feed.
   */
  const needsYouCount = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:needs-you-count",
    tag: WS_METHODS.adeGetNeedsYouCount,
    staleTimeMs: 5_000,
    refreshIntervalMs: 15_000,
  });

  /**
   * Project view header + crew (spec §7 slice 3, panel 1). Crew membership
   * changes about as often as the roster does, so it shares that cadence.
   */
  const project = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:project",
    tag: WS_METHODS.adeGetProject,
    staleTimeMs: 2_000,
    refreshIntervalMs: 15_000,
  });

  /**
   * Integration queue (slice 3, panel 2). Polled harder than the rest of the
   * page: a queue pass moves a candidate through `running` in seconds, and a
   * panel that showed the head as `queued` for fifteen of them would be
   * describing a pipeline that has already moved on.
   */
  const projectCandidates = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:project-candidates",
    tag: WS_METHODS.adeListProjectCandidates,
    staleTimeMs: 1_000,
    refreshIntervalMs: 5_000,
  });

  /**
   * Publication stack (slice 3, panel 3). A stack pass is a network round trip
   * to GitHub, so PR state moves in minutes; polling it at the queue's rate
   * would only spend the connection.
   */
  const projectPublicationStack = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:project-publication-stack",
    tag: WS_METHODS.adeGetProjectPublicationStack,
    staleTimeMs: 5_000,
    refreshIntervalMs: 30_000,
  });

  /** Assignment lineage for the work graph (slice 4). */
  const assignmentGraph = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:assignment-graph",
    tag: WS_METHODS.adeGetAssignmentGraph,
    staleTimeMs: 2_000,
    refreshIntervalMs: 10_000,
  });

  const refreshRoster = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(roster({ environmentId: target.environmentId, input: {} }));
    });

  const refreshBot = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly botId: BotId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(
        bot({ environmentId: target.environmentId, input: { botId: target.input.botId } }),
      );
    });

  return {
    /**
     * Latest `FleetHealthSnapshot` pushed by the server's health checker.
     * `idleTtlMs: 0` keeps the pill feed live while any subscriber exists and
     * drops the subscription as soon as the last pill unmounts.
     */
    fleetHealth: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:ade:fleet-health",
      tag: WS_METHODS.subscribeAdeFleetHealth,
      idleTtlMs: 0,
    }),
    roster,
    bot,
    needsYouCount,
    project,
    projectCandidates,
    projectPublicationStack,
    assignmentGraph,
    /** Adds one crew bot; the roster is what changed, so only it is re-read. */
    createBotFromTemplate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:create-bot-from-template",
      tag: WS_METHODS.adeCreateBotFromTemplate,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSettled: (target, registry) => refreshRoster(target, registry),
    }),
    /**
     * Creates an ADE project and its Second Mate. Both the project list and
     * the roster change, so the roster (which carries both) is re-read.
     */
    createProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:create-project",
      tag: WS_METHODS.adeCreateProject,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSettled: (target, registry) => refreshRoster(target, registry),
    }),
    writeBotMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:write-bot-memory",
      tag: WS_METHODS.adeWriteBotMemory,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      // Re-read even on failure: a conflict means the panel is holding a
      // document the server has since replaced, and the editor needs the new
      // `updatedAt` before the captain can retry.
      onSettled: (target, registry) => refreshBot(target, registry),
    }),
    editBotPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:edit-bot-persona",
      tag: WS_METHODS.adeEditBotPersona,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) => refreshBot(target, registry),
    }),
    /** Roster rows carry no computer-use flag today, but the bot header does. */
    setBotComputerUse: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:set-bot-computer-use",
      tag: WS_METHODS.adeSetBotComputerUse,
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) =>
        refreshBot(target, registry).pipe(Effect.andThen(refreshRoster(target, registry))),
    }),
    /**
     * Lazily starts (or reuses) the bot's `primary-text` session. Single-flight
     * per bot: a double click must not buy two kernel sessions.
     */
    startBotChat: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:start-bot-chat",
      tag: WS_METHODS.adeStartBotChat,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) =>
        refreshBot(target, registry).pipe(Effect.andThen(refreshRoster(target, registry))),
    }),
  };
}
