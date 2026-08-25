import type { EnvironmentId, ScopedThreadRef } from "@shuv2code/contracts";
import { emptyAgentPanelModel } from "@shuv2code/client-runtime/state/subagentRuntime";
import type { TimestampFormat } from "@shuv2code/contracts/settings";
import { useMemo } from "react";

import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import {
  TimelineRowHost,
  type TimelineRowActivityState,
  type TimelineRowSharedState,
} from "../chat/MessagesTimeline";
import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import type { SpeechPlaybackState } from "../../textToSpeech/SpeechPlaybackController";

/**
 * The adapter for MESSENGER-PIVOT resolved flaw #1.
 *
 * `TimelineRowContent` was module-private behind two `createContext(null!)`
 * contexts whose value — `TimelineRowSharedState` — is an 18-field bag computed
 * inside `ChatView`. "Export a host" was never a one-liner: half those fields
 * are workspace affordances (open the turn diff, open the Agents panel, revert
 * to a checkpoint, speak a message) that the captain messenger has no surface
 * for and must not silently pretend to have.
 *
 * So this file is the contract. Every field of both contexts is enumerated
 * below and sorted into exactly one of two buckets:
 *
 * **Real display values** — supplied by the caller, because getting them wrong
 * makes the row render wrong: `timestampFormat`, `routeThreadKey`, `threadRef`,
 * `markdownCwd`, `resolvedTheme`, `workspaceRoot`, `skills`,
 * `activeThreadEnvironmentId`, `onImageExpand`, plus the two disclosure
 * callbacks (`onToggleTurnFold`, `onToggleWorkGroup`) which the messenger owns
 * locally, and the whole activity context.
 *
 * **Enumerated stubs** — workspace-only, deliberately inert here:
 * - `onOpenTurnDiff` — no diff panel in the messenger; M5's `PrResultCard` is
 *   the captain-facing route to a diff.
 * - `onOpenAgents` + `agentPanelModel` — no Agents panel. The empty model makes
 *   the spawn CTA render as "no agents" rather than throw, so the row degrades
 *   to a label instead of blanking the subtree.
 * - `onRevertUserMessage` — reverting a checkpoint is a worktree operation on a
 *   surface with no worktree selector. A messenger that offered it would be
 *   lying about what it can undo.
 * - `speechPlaybackState` / `onToggleAssistantSpeech` — text-to-speech is a
 *   workspace toolbar feature; idle + no-op keeps the control quiet.
 *
 * If `TimelineRowSharedState` grows a field, this file stops compiling. That is
 * the point: a new workspace callback has to be classified here, in the open,
 * rather than leaking a `null!` context read into a captain render.
 */

const EMPTY_SKILLS: TimelineRowSharedState["skills"] = [];
const IDLE_SPEECH_PLAYBACK: SpeechPlaybackState = { status: "idle", messageId: null };
const NOOP = () => {};

/** The stub half of the contract, in one place so the test can pin it. */
export const CAPTAIN_ROW_HOST_STUBS = {
  onRevertUserMessage: NOOP,
  onOpenTurnDiff: NOOP,
  onOpenAgents: NOOP,
  agentPanelModel: emptyAgentPanelModel(),
  speechPlaybackState: IDLE_SPEECH_PLAYBACK,
  onToggleAssistantSpeech: NOOP,
} satisfies Pick<
  TimelineRowSharedState,
  | "onRevertUserMessage"
  | "onOpenTurnDiff"
  | "onOpenAgents"
  | "agentPanelModel"
  | "speechPlaybackState"
  | "onToggleAssistantSpeech"
>;

export interface CaptainRowHostDisplayState {
  readonly timestampFormat: TimestampFormat;
  readonly routeThreadKey: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly resolvedTheme: "light" | "dark";
  /** Bots have no worktree; both of these are `undefined` on this surface. */
  readonly markdownCwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly skills?: TimelineRowSharedState["skills"] | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly onToggleTurnFold?: ((foldId: string) => void) | undefined;
  readonly onToggleWorkGroup?: ((groupId: string, anchorKey?: string) => void) | undefined;
}

export interface CaptainRowHostActivity {
  readonly isWorking?: boolean | undefined;
  readonly activeTurnInProgress?: boolean | undefined;
  readonly latestTurnId?: TimelineRowActivityState["latestTurnId"] | undefined;
  readonly workingStepLabel?: string | null | undefined;
}

/**
 * Builds the synthesized shared state. Exported separately from the component
 * so the seam can be asserted without rendering.
 */
export function buildCaptainRowSharedState(
  display: CaptainRowHostDisplayState,
): TimelineRowSharedState {
  return {
    timestampFormat: display.timestampFormat,
    routeThreadKey: display.routeThreadKey,
    threadRef: display.threadRef,
    markdownCwd: display.markdownCwd,
    resolvedTheme: display.resolvedTheme,
    workspaceRoot: display.workspaceRoot,
    skills: display.skills ?? EMPTY_SKILLS,
    activeThreadEnvironmentId: display.activeThreadEnvironmentId,
    onImageExpand: display.onImageExpand ?? NOOP,
    onToggleTurnFold: display.onToggleTurnFold ?? NOOP,
    onToggleWorkGroup: display.onToggleWorkGroup ?? NOOP,
    ...CAPTAIN_ROW_HOST_STUBS,
  };
}

/**
 * Builds the activity context. A messenger conversation is never
 * "reverting a checkpoint", so that field is fixed rather than plumbed.
 */
export function buildCaptainRowActivityState(
  activity: CaptainRowHostActivity,
): TimelineRowActivityState {
  return {
    isWorking: activity.isWorking ?? false,
    isRevertingCheckpoint: false,
    activeTurnInProgress: activity.activeTurnInProgress ?? false,
    latestTurnId: activity.latestTurnId ?? null,
    workingStepLabel: activity.workingStepLabel ?? null,
  };
}

/**
 * Mounts one genuine IDE timeline row inside the captain messenger. `TraceCard`
 * expands into this, so a tool call, work group, diff, or plan renders exactly
 * as it does in the workspace instead of through a second, drifting parser.
 */
export function CaptainRowHost({
  row,
  display,
  activity,
}: {
  readonly row: MessagesTimelineRow;
  readonly display: CaptainRowHostDisplayState;
  readonly activity?: CaptainRowHostActivity | undefined;
}) {
  const sharedState = useMemo(() => buildCaptainRowSharedState(display), [display]);
  const activityState = useMemo(() => buildCaptainRowActivityState(activity ?? {}), [activity]);
  return <TimelineRowHost row={row} sharedState={sharedState} activityState={activityState} />;
}
