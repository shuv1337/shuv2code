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
   * The captain's crew list, live (`docs/ade/MESSENGER-PIVOT.md` §4, M3).
   *
   * This was a 15s poll while a roster row only said which project a bot lived
   * in. It carries previews, unread counts and attention lines now, and those
   * are exactly the fields a poll interval is most visibly wrong about — a
   * messenger whose contact list lags a quarter of a minute behind the
   * conversation next to it does not read as slow, it reads as broken. The
   * server debounces and change-gates the frames, so a quiet fleet costs one
   * idle subscription.
   *
   * `idleTtlMs: 0`, like the pill feed: the rail is either on screen or it is
   * not, and a rail nobody is looking at should not hold a subscription open.
   */
  const roster = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:ade:roster",
    tag: WS_METHODS.subscribeAdeRoster,
    idleTtlMs: 0,
  });

  /** One bot's bindings, memory, persona history and open assignments. */
  const bot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:bot",
    tag: WS_METHODS.adeGetBot,
    staleTimeMs: 2_000,
    refreshIntervalMs: 15_000,
  });

  /**
   * One bot's desktop state for the Screen tab (spec §4.6).
   *
   * Polled faster than the rest of the bot detail because it is the surface a
   * captain watches while pressing Start and waiting for a container to come
   * up. The read never provisions, so a fast poll costs nothing but a status
   * lookup.
   */
  const botScreen = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:bot-screen",
    tag: WS_METHODS.adeGetBotScreen,
    staleTimeMs: 1_000,
    refreshIntervalMs: 5_000,
  });

  /**
   * Which workspace project a bot's routines belong to (messenger pivot §4,
   * M6).
   *
   * Barely polled: the answer only changes when a project is created or a repo
   * is bound, both of which are captain actions elsewhere in the app, and the
   * rail's routine list is keyed on the resolved project so a stale-by-a-minute
   * answer costs nothing.
   */
  const botRoutineContext = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:bot-routine-context",
    tag: WS_METHODS.adeGetBotRoutineContext,
    staleTimeMs: 10_000,
    refreshIntervalMs: 60_000,
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
   * The Needs You inbox (spec §7 slice 5). Polled on the badge's cadence: the
   * list and the badge are two views of one number, and letting them drift by
   * a different interval is how a captain ends up staring at a badge whose
   * inbox is empty.
   */
  const needsYou = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:needs-you",
    tag: WS_METHODS.adeListNeedsYou,
    staleTimeMs: 5_000,
    refreshIntervalMs: 15_000,
  });

  /** One item, for the inbox detail pane. */
  const needsYouItem = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:needs-you-item",
    tag: WS_METHODS.adeGetNeedsYouItem,
    staleTimeMs: 5_000,
    refreshIntervalMs: 15_000,
  });

  /**
   * Re-read everything a decision moves. Both renderings of an item share
   * these atoms, so approving inline updates the inbox and the badge without
   * either surface knowing the other exists.
   */
  const refreshNeedsYou = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(
        needsYou({ environmentId: target.environmentId, input: { includeResolved: false } }),
      );
      registry.refresh(
        needsYou({ environmentId: target.environmentId, input: { includeResolved: true } }),
      );
      registry.refresh(needsYouCount({ environmentId: target.environmentId, input: {} }));
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

  /**
   * One publication stack by id (MESSENGER-PIVOT §6 M5) — the messenger's
   * `PrResultCard`, which starts from a delivery's `publicationLayer` artifact
   * and so knows a stack id rather than a project id.
   *
   * Same cadence as the project-keyed read for the same reason: a stack pass is
   * a round trip to GitHub, and a card in a conversation is read once and
   * scrolled past, not watched.
   */
  const publicationStack = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:ade:publication-stack",
    tag: WS_METHODS.adeGetPublicationStack,
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

  /**
   * Re-reading the roster after a mutation used to be the only way the rail
   * heard about it. It is no longer: `subscribeAdeRoster` pushes the next frame
   * within the server's debounce window, so a refresh here would tear down and
   * re-establish a live subscription to learn something arriving anyway. Kept
   * as a named no-op rather than deleted at every call site, so the mutations
   * still say out loud which of them change the rail (M3).
   */
  const refreshRoster = (
    _target: { readonly environmentId: EnvironmentId },
    _registry: AtomRegistry.AtomRegistry,
  ) => Effect.void;

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

  const refreshBotScreen = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly botId: BotId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(
        botScreen({ environmentId: target.environmentId, input: { botId: target.input.botId } }),
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
    botScreen,
    botRoutineContext,
    needsYouCount,
    project,
    projectCandidates,
    projectPublicationStack,
    publicationStack,
    assignmentGraph,
    needsYou,
    needsYouItem,
    /**
     * Approve or deny (requires an `ade:approve`-scoped connection, spec §5).
     * Serialized per item so a double click cannot race itself into a
     * spurious conflict, and re-read on failure as well as success: a benign
     * "already resolved" means the list on screen is stale.
     */
    submitNeedsYouDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:submit-needs-you-decision",
      tag: WS_METHODS.adeSubmitNeedsYouDecision,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.needsYouItemId}`,
      },
      onSettled: (target, registry) =>
        refreshNeedsYou(target, registry).pipe(
          Effect.andThen(
            Effect.sync(() => {
              registry.refresh(
                needsYouItem({
                  environmentId: target.environmentId,
                  input: { needsYouItemId: target.input.needsYouItemId },
                }),
              );
            }),
          ),
        ),
    }),
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
     * Rename / re-decorate / re-tag / re-group one bot (messenger pivot §4,
     * #197).
     *
     * `latest` rather than `serial`: the identity sheet saves on every keystroke
     * pause, and only the last label the captain typed is worth writing.
     * Both the bot detail and the roster carry the name, so both are re-read —
     * a rail still showing the old name after a rename is the bug this ticket
     * exists to avoid.
     */
    updateBotIdentity: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:update-bot-identity",
      tag: WS_METHODS.adeUpdateBotIdentity,
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) =>
        refreshBot(target, registry).pipe(Effect.andThen(refreshRoster(target, registry))),
    }),
    /**
     * Pin one bot to one shuvcode model.
     *
     * `serial` rather than `latest`: the payload can ask for a session restart,
     * and dropping a superseded call would drop that side effect while
     * reporting success. The bot detail carries the slug the picker renders, so
     * it is the read that has to move.
     */
    setBotModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:set-bot-model",
      tag: WS_METHODS.adeSetBotModel,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) => refreshBot(target, registry),
    }),
    /**
     * Create or rename/reorder a contact group. The roster carries the group
     * list, so it is the one read that has to move.
     */
    upsertBotGroup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:upsert-bot-group",
      tag: WS_METHODS.adeUpsertBotGroup,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSettled: (target, registry) => refreshRoster(target, registry),
    }),
    /**
     * Delete a group. Its members are ungrouped, not deleted, so the roster
     * still lists every one of them — under the trailing Ungrouped header.
     */
    deleteBotGroup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:delete-bot-group",
      tag: WS_METHODS.adeDeleteBotGroup,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSettled: (target, registry) => refreshRoster(target, registry),
    }),
    /**
     * Explicit captain Start from the Screen tab. Single-flight per bot: a
     * double click must not race two provisions against the desktop cap.
     */
    startBotDesktop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:start-bot-desktop",
      tag: WS_METHODS.adeStartBotDesktop,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) => refreshBotScreen(target, registry),
    }),
    /** Explicit captain Stop. Shares Start's key so the two cannot interleave. */
    stopBotDesktop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:stop-bot-desktop",
      tag: WS_METHODS.adeStopBotDesktop,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) => refreshBotScreen(target, registry),
    }),
    /**
     * Confirm-gated delete. The bot is gone afterwards, so the roster is what
     * the captain returns to and it must not still list the deleted row.
     */
    deleteBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:delete-bot",
      tag: WS_METHODS.adeDeleteBot,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
      onSettled: (target, registry) => refreshRoster(target, registry),
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
    /**
     * "I have seen this conversation" (M3). Fired from more than one trigger,
     * which is why the concurrency mode matters: `latest` per bot collapses a
     * burst — focus, then reaching the bottom, then another message arriving
     * while still at the bottom — into one write, and guarantees the *last*
     * intent wins rather than whichever request the network happened to
     * deliver first. The mark is monotonic server-side either way; this just
     * stops the client generating the churn.
     */
    markBotChatRead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ade:mark-bot-chat-read",
      tag: WS_METHODS.adeMarkBotChatRead,
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.botId}`,
      },
    }),
  };
}
