/**
 * "Is this bot's model actually able to drive it?" — the two facts the captain
 * needs and could not previously see (issue #223 follow-up).
 *
 * Both facts are *observational*, not configuration: one comes from what the
 * provider reported about the model, the other from what the model then did.
 * They are tracked here rather than in the tool gate because the gate must not
 * grow state about models, and rather than in a table because a counter that
 * outlives the process would accuse a session that no longer exists.
 */
import type { ThreadId } from "@shuv2code/contracts";

/**
 * How many malformed tool-call payloads on one session before the captain is
 * told the model cannot call tools. One is noise, two is bad luck; three
 * inside a single session is the loop that was observed on the VM.
 */
export const ADE_MALFORMED_TOOL_INPUT_THRESHOLD = 3;

/** What a bot's chat reports about its model at session start. */
export type AdeModelHealth = "ok" | "unreported-tools" | "malformed-tool-input";

interface ThreadState {
  /** The kernel session the count belongs to; a new session starts over. */
  sessionId: string | null;
  count: number;
  latched: boolean;
}

export interface AdeModelHealthTracker {
  /**
   * Bind a thread to the kernel session its counts belong to. A *different*
   * session id clears the count; the same one keeps it, which is what lets a
   * captain reopen a looping conversation and still be told why.
   */
  readonly bindSession: (input: { threadId: ThreadId; sessionId: string }) => void;
  /** One refused, never-executed tool call. Returns true when it latched now. */
  readonly noteMalformedToolInput: (threadId: ThreadId) => boolean;
  /** Has this thread's model been caught emitting unusable tool calls? */
  readonly isMalformed: (threadId: ThreadId) => boolean;
  /** Forget a thread entirely (binding closed, thread detached). */
  readonly clearThread: (threadId: ThreadId) => void;
}

export function createAdeModelHealthTracker(
  threshold: number = ADE_MALFORMED_TOOL_INPUT_THRESHOLD,
): AdeModelHealthTracker {
  const byThread = new Map<ThreadId, ThreadState>();
  const stateFor = (threadId: ThreadId): ThreadState => {
    const existing = byThread.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadState = { sessionId: null, count: 0, latched: false };
    byThread.set(threadId, created);
    return created;
  };
  return {
    bindSession: ({ threadId, sessionId }) => {
      const state = stateFor(threadId);
      if (state.sessionId !== null && state.sessionId !== sessionId) {
        state.count = 0;
        state.latched = false;
      }
      state.sessionId = sessionId;
    },
    noteMalformedToolInput: (threadId) => {
      const state = stateFor(threadId);
      state.count += 1;
      // Latched: reported once per session, never re-armed, so a long
      // conversation cannot turn one bad model into a stream of notices.
      if (state.latched || state.count < threshold) return false;
      state.latched = true;
      return true;
    },
    isMalformed: (threadId) => byThread.get(threadId)?.latched === true,
    clearThread: (threadId) => {
      byThread.delete(threadId);
    },
  };
}

/**
 * The process-wide tracker. A module singleton rather than a service because
 * both ends of it — the dispatch loop that counts and the chat session that
 * reports — are already singletons in the app layer, and threading a fourth
 * dependency through two unrelated layer signatures buys nothing.
 */
export const adeModelHealthTracker: AdeModelHealthTracker = createAdeModelHealthTracker();
