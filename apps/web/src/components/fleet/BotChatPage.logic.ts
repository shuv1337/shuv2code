/**
 * Pure branching and copy for the Firstmate/bot chat surface (spec §7 slice 1,
 * §4.1). Two rules live here and nowhere else:
 *
 *  1. Opening this page must never start a kernel session. A bot with no
 *     active `primary-text` binding gets the canned welcome and an explicit
 *     "Start chatting" button; the session is bought on that click.
 *  2. The app is never gated on kernels. A `session_unavailable` refusal is
 *     shown inline and the page stays navigable.
 */
import type { AdeBotDetail, ThreadId } from "@shuv2code/contracts";

import {
  activePrimaryBinding,
  adeCaptainErrorMessage,
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
  | { readonly kind: "loading" }
  /** The bot (or roster) could not be read — say so instead of spinning. */
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "welcome"; readonly copy: BotChatWelcomeCopy }
  /** A live session exists (already warm, or just started) — render ChatView. */
  | { readonly kind: "chat"; readonly threadId: ThreadId };

export interface BotChatWelcomeCopy {
  readonly greeting: string;
  readonly projectCta: string | null;
  readonly kernelHint: string;
  readonly startLabel: string;
}

const KERNEL_HINT =
  "This bot runs on the shuvcode kernel. It needs `shuvcode service start` running and an " +
  "opencode2 provider instance in Settings → Providers (with Binary path pointing at your " +
  "shuvcode CLI). You can open the chat either way — it will tell you what is missing.";

const PROJECT_CTA = "Create your first project so this bot has somewhere to work.";

export function getBotChatWelcomeCopy(input: {
  readonly botName: string;
  readonly hasProjects: boolean;
}): BotChatWelcomeCopy {
  return {
    greeting: `${input.botName} is standing by. Nothing is running yet — no session starts until you say so.`,
    projectCta: input.hasProjects ? null : PROJECT_CTA,
    kernelHint: KERNEL_HINT,
    startLabel: "Start chatting",
  };
}

/**
 * What the page renders. `startedThreadId` is the thread the `startBotChat`
 * command handed back this session; it wins over the loaded detail because the
 * detail re-read may not have landed yet.
 */
export function getBotChatBody(input: {
  readonly detail: AdeBotDetail | null;
  readonly startedThreadId: ThreadId | null;
  readonly hasProjects: boolean;
  /** Load failure from `ade.getBot` / `ade.getRoster`, if any. */
  readonly loadError?: unknown;
}): BotChatBody {
  if (input.startedThreadId !== null) {
    return { kind: "chat", threadId: input.startedThreadId };
  }
  // A failed read is terminal until the query retries: rendering skeletons
  // forever tells the captain nothing, so surface the reason instead.
  if (input.detail === null && input.loadError !== undefined && input.loadError !== null) {
    return {
      kind: "error",
      message: adeCaptainErrorMessage(input.loadError, "This bot could not be loaded."),
    };
  }
  if (input.detail === null) {
    return { kind: "loading" };
  }
  const binding = activePrimaryBinding(input.detail.bindings);
  if (binding === null) {
    return {
      kind: "welcome",
      copy: getBotChatWelcomeCopy({
        botName: input.detail.bot.name,
        hasProjects: input.hasProjects,
      }),
    };
  }
  // A warm binding names a kernel session, not a thread. The thread is what
  // `startBotChat` resolves, and it reuses the binding rather than buying a
  // second one — so the page still asks for it, but never on mount.
  return {
    kind: "welcome",
    copy: {
      ...getBotChatWelcomeCopy({
        botName: input.detail.bot.name,
        hasProjects: input.hasProjects,
      }),
      greeting: `${input.detail.bot.name} already has a session open.`,
      startLabel: "Resume chatting",
    },
  };
}

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
