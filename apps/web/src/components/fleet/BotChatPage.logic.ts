/**
 * Pure branching and copy for the Firstmate/bot chat surface (spec §7 slice 1,
 * §4.1). Two rules live here and nowhere else:
 *
 *  1. Opening a bot conversation *is* the request to connect (M8, #217). The
 *     lazy-session rule used to be "on button press", which bought a landing
 *     page, a "Start chatting"/"Resume chatting" fork, and a paragraph of
 *     kernel setup between the captain and the conversation. It is now "on
 *     conversation open": the page auto-starts once per mount, and the server
 *     is already safe for that — `startPrimaryChat` holds a per-thread lock and
 *     gates on `hasSession`, so a second call adopts rather than re-mints.
 *  2. The app is never gated on kernels. A `session_unavailable` refusal is
 *     shown as a compact inline notice over the conversation shell, never as a
 *     landing page, and the page stays navigable.
 */
import type { AdeBotChatSession, AdeBotDetail, BotId, ThreadId } from "@shuv2code/contracts";

import {
  adeCaptainErrorParts,
  openAssignments,
  runningAssignment,
  structuralRoleLabel,
} from "../../state/ade.logic";

export interface BotChatHeaderView {
  readonly name: string;
  readonly roleLabel: string;
  readonly roleTag: string;
  readonly projectLabel: string;
  readonly openAssignmentLabel: string | null;
  /** The instruction of the assignment actually executing, if any. */
  readonly runningInstruction: string | null;
}

export type BotChatBody =
  /** The bot detail is still being read; the conversation shell connects. */
  | { readonly kind: "connecting" }
  /** The bot (or roster) could not be read — say so instead of spinning. */
  | { readonly kind: "error"; readonly message: string; readonly details: string | null }
  /** A live session exists (already warm, or just started) — render the thread. */
  | { readonly kind: "chat"; readonly threadId: ThreadId };

/**
 * The one project-setup nudge that survived the de-narration sweep (#217).
 *
 * It is not conversation chrome and it is not a landing page: a workspace with
 * no project has nowhere for the bot to work, so this is a real precondition
 * with a real next action rather than a description of what the UI is about to
 * do.
 */
export const BOT_CHAT_NO_PROJECT_NOTICE = "This bot has no project yet.";
export const BOT_CHAT_NO_PROJECT_ACTION = "Create project";

/**
 * What to do while a session exists but the thread has not arrived in the
 * client store yet.
 *
 * "Waiting" must be a state with an exit. The thread route can afford to spin
 * because a stuck route is a blank page the captain navigates away from; this
 * page owns a bot that already has a live kernel session, so a permanent
 * shimmer strands them with no way to ask again. Every terminal condition
 * therefore resolves to `retry`.
 */
export type ChatSyncOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "ready" }
  | { readonly kind: "retry"; readonly message: string; readonly details: string | null };

/** How long to wait for the thread before offering the way out. */
export const CHAT_SYNC_TIMEOUT_MS = 30_000;

const SYNC_TIMEOUT_MESSAGE = "This conversation didn't finish loading.";
const SYNC_MISSING_MESSAGE = "This conversation is no longer on the server.";

export function resolveChatSyncOutcome(input: {
  /** From `resolveThreadRouteRenderState`. */
  readonly renderState: "loading" | "ready" | "missing";
  readonly threadShellExists: boolean;
  /** Error from the environment shell query, if any. */
  readonly shellError?: unknown;
  /** Milliseconds since the session was started, for the bounded fallback. */
  readonly elapsedMs: number;
}): ChatSyncOutcome {
  if (input.shellError !== undefined && input.shellError !== null) {
    // Headline and detail stay split: the raw reason is technical remediation
    // and belongs behind the notice's disclosure, not in the primary sentence.
    const parts = adeCaptainErrorParts(input.shellError, SYNC_TIMEOUT_MESSAGE);
    return { kind: "retry", message: parts.headline, details: parts.details };
  }
  if (
    input.renderState === "ready" ||
    (input.renderState === "loading" && input.threadShellExists)
  ) {
    return { kind: "ready" };
  }
  // `missing` after bootstrap is terminal: the thread is not coming.
  if (input.renderState === "missing") {
    return { kind: "retry", message: SYNC_MISSING_MESSAGE, details: null };
  }
  if (input.elapsedMs >= CHAT_SYNC_TIMEOUT_MS) {
    return { kind: "retry", message: SYNC_TIMEOUT_MESSAGE, details: null };
  }
  return { kind: "waiting" };
}

/**
 * What the page renders. `startedThreadId` is the thread the `startBotChat`
 * command handed back this mount; it wins over the loaded detail because the
 * detail re-read may not have landed yet.
 *
 * There is no longer a "welcome" arm. Whether the bot has a warm
 * `primary-text` binding used to pick between "Start chatting" and "Resume
 * chatting" — a fork the captain could not act on differently and did not ask
 * for. Both cases now do the same thing (connect), so the distinction has no
 * rendering left to drive.
 */
export function getBotChatBody(input: {
  readonly detail: AdeBotDetail | null;
  readonly startedThreadId: ThreadId | null;
  /** Load failure from `ade.getBot` / `ade.getRoster`, if any. */
  readonly loadError?: unknown;
}): BotChatBody {
  if (input.startedThreadId !== null) {
    return { kind: "chat", threadId: input.startedThreadId };
  }
  // A failed read is terminal until the query retries: rendering skeletons
  // forever tells the captain nothing, so surface the reason instead.
  if (input.detail === null && input.loadError !== undefined && input.loadError !== null) {
    const parts = adeCaptainErrorParts(input.loadError, "This bot could not be loaded.");
    return { kind: "error", message: parts.headline, details: parts.details };
  }
  return { kind: "connecting" };
}

/**
 * Should this mount fire `startBotChat`?
 *
 * The whole of M8's "open the conversation *is* the request to connect" rule,
 * kept pure so it can be pinned by a test in a suite with no DOM.
 *
 * `startedFor` is the bot this mount has already started for — the effect holds
 * it in a ref rather than in state, because a ref is written synchronously
 * during the effect and therefore survives React's development double-invoke of
 * mount effects (StrictMode). Re-running the effect against the ref it just set
 * returns `false`, so exactly one start is issued per mount per bot even though
 * the effect body runs twice.
 *
 * A start is never issued before the environment resolves; there is nothing to
 * address the command to, and doing it anyway would burn the mount's one
 * attempt on a call that cannot succeed.
 */
export function shouldAutoStartChat(input: {
  readonly botId: BotId;
  readonly environmentReady: boolean;
  readonly startedFor: BotId | null;
}): boolean {
  if (!input.environmentReady) return false;
  return input.startedFor !== input.botId;
}

/**
 * The compact inline notice shown *over the conversation shell* when connecting
 * failed (#217). Never a landing page.
 */
export interface BotChatConnectNotice {
  /** One sentence, product voice, naming the remedy. */
  readonly message: string;
  /**
   * Technical remediation — provider instance ids, `shuvcode service start`,
   * binary paths. Rendered only inside the notice's collapsed "Details"
   * disclosure, never as primary copy.
   */
  readonly details: string | null;
}

/**
 * The three states the conversation region can be in once M8 removed the
 * interstitial. There is no fourth: every path that used to end at a landing
 * page now ends at `failed`, which still renders the conversation shell.
 */
export type BotChatConnectState =
  | { readonly kind: "connecting" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly notice: BotChatConnectNotice };

const START_FAILED_FALLBACK = "This bot couldn't connect.";

export function resolveBotChatConnectState(input: {
  readonly body: BotChatBody;
  readonly syncOutcome: ChatSyncOutcome;
  /** Failure from the `startBotChat` command on this mount, if any. */
  readonly startError: BotChatConnectNotice | null;
  /** The thread is in the client store and safe to mount (#197). */
  readonly chatReady: boolean;
}): BotChatConnectState {
  // A failed read of the bot itself outranks everything: there is no session to
  // wait for.
  if (input.body.kind === "error") {
    return {
      kind: "failed",
      notice: { message: input.body.message, details: input.body.details },
    };
  }
  if (input.startError !== null) {
    return { kind: "failed", notice: input.startError };
  }
  if (input.syncOutcome.kind === "retry") {
    return {
      kind: "failed",
      notice: { message: input.syncOutcome.message, details: input.syncOutcome.details },
    };
  }
  if (input.chatReady) return { kind: "ready" };
  return { kind: "connecting" };
}

/** Split a `startBotChat` failure into headline and disclosure. */
export function botChatStartNotice(error: unknown): BotChatConnectNotice {
  const parts = adeCaptainErrorParts(error, START_FAILED_FALLBACK);
  return { message: parts.headline, details: parts.details };
}

/** The composer only accepts input on a live session. */
export function isBotChatComposerDisabled(state: BotChatConnectState): boolean {
  return state.kind !== "ready";
}

/**
 * Should the "fleet tools unavailable" strip be shown for this start?
 *
 * Only a `missing` probe is evidence — the kernel answered and the catalog is
 * not there. `unknown` means the server could not ask (no live adapter session
 * at probe time, the state every restart starts in), and telling the captain
 * their fleet is broken on a question nobody managed to ask is issue #199. The
 * answer is simply re-taken on the next start, so silence here costs nothing.
 */
export function shouldWarnToolsMissing(session: AdeBotChatSession): boolean {
  return session.toolsProbe === "missing";
}

/**
 * The delegation-down strip (a *start-time snapshot*: it reflects what the
 * catalog probe saw when the session opened and is never re-checked, so a
 * kernel upgraded mid-session keeps showing it until the conversation is
 * reopened).
 *
 * The strip survived M8's sweep because delegation is genuinely down — this is
 * a capability the captain will otherwise watch fail silently. Its copy did
 * not: the headline now states the state, and the kernel remediation moved into
 * the disclosure.
 */
export const BOT_CHAT_TOOLS_MISSING_NOTICE: BotChatConnectNotice = {
  message: "Delegation and memory are unavailable for this bot.",
  details:
    "The fleet tool catalog came back empty on this kernel build. Restart `shuvcode service` on " +
    "a build with the dynamic-tool extension, then reopen this conversation.",
};

export function getBotChatHeaderView(detail: AdeBotDetail): BotChatHeaderView {
  const open = openAssignments(detail);
  const running = runningAssignment(detail);
  return {
    name: detail.bot.name,
    roleLabel: structuralRoleLabel(detail.bot.structuralRole),
    roleTag: detail.bot.roleTag,
    projectLabel: detail.projectName ?? "Fleet-wide",
    openAssignmentLabel:
      open.length === 0
        ? null
        : open.length === 1
          ? "1 open assignment"
          : `${open.length} open assignments`,
    runningInstruction: running === null ? null : running.instruction,
  };
}
