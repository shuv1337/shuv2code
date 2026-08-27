/**
 * The liar counter. The bug it exists for was *silence*: a model emitted
 * pseudo-XML instead of JSON tool calls, the kernel refused every one, and
 * nothing anywhere said so — so the interesting assertions are about when the
 * verdict latches, when it survives, and when it is thrown away.
 */
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { ThreadId } from "@shuv2code/contracts";

import {
  ADE_MALFORMED_TOOL_INPUT_THRESHOLD,
  createAdeModelHealthTracker,
} from "./adeModelHealth.ts";

const THREAD_A = ThreadId.make("ade-bot-a");
const THREAD_B = ThreadId.make("ade-bot-b");

describe("createAdeModelHealthTracker", () => {
  it("stays quiet below the threshold and latches exactly once at it", () => {
    const tracker = createAdeModelHealthTracker();
    tracker.bindSession({ threadId: THREAD_A, sessionId: "session-1" });

    const latches: Array<boolean> = [];
    for (let index = 0; index < ADE_MALFORMED_TOOL_INPUT_THRESHOLD + 2; index += 1) {
      latches.push(tracker.noteMalformedToolInput(THREAD_A));
    }

    NodeAssert.deepEqual(latches, [false, false, true, false, false]);
    NodeAssert.equal(ADE_MALFORMED_TOOL_INPUT_THRESHOLD, 3);
    NodeAssert.equal(tracker.isMalformed(THREAD_A), true);
  });

  it("counts per bot: one bot's bad model never accuses another", () => {
    const tracker = createAdeModelHealthTracker();
    tracker.bindSession({ threadId: THREAD_A, sessionId: "session-1" });
    tracker.bindSession({ threadId: THREAD_B, sessionId: "session-2" });

    for (let index = 0; index < ADE_MALFORMED_TOOL_INPUT_THRESHOLD; index += 1) {
      tracker.noteMalformedToolInput(THREAD_A);
    }
    tracker.noteMalformedToolInput(THREAD_B);

    NodeAssert.equal(tracker.isMalformed(THREAD_A), true);
    NodeAssert.equal(tracker.isMalformed(THREAD_B), false);
  });

  it("starts over when the thread is bound to a different kernel session", () => {
    const tracker = createAdeModelHealthTracker();
    tracker.bindSession({ threadId: THREAD_A, sessionId: "session-1" });
    for (let index = 0; index < ADE_MALFORMED_TOOL_INPUT_THRESHOLD; index += 1) {
      tracker.noteMalformedToolInput(THREAD_A);
    }
    NodeAssert.equal(tracker.isMalformed(THREAD_A), true);

    // A rollover or a re-minted session is a new model run; the old verdict
    // would be an accusation about a session that no longer exists.
    tracker.bindSession({ threadId: THREAD_A, sessionId: "session-2" });
    NodeAssert.equal(tracker.isMalformed(THREAD_A), false);
  });

  it("keeps the verdict when the same session is re-bound", () => {
    const tracker = createAdeModelHealthTracker();
    tracker.bindSession({ threadId: THREAD_A, sessionId: "session-1" });
    for (let index = 0; index < ADE_MALFORMED_TOOL_INPUT_THRESHOLD; index += 1) {
      tracker.noteMalformedToolInput(THREAD_A);
    }

    // Reopening the conversation rebinds the *same* session. This is the path
    // on which the captain finally reads the notice, so it must not reset.
    tracker.bindSession({ threadId: THREAD_A, sessionId: "session-1" });
    NodeAssert.equal(tracker.isMalformed(THREAD_A), true);
  });

  it("forgets a thread whose binding was retired", () => {
    const tracker = createAdeModelHealthTracker();
    tracker.bindSession({ threadId: THREAD_A, sessionId: "session-1" });
    for (let index = 0; index < ADE_MALFORMED_TOOL_INPUT_THRESHOLD; index += 1) {
      tracker.noteMalformedToolInput(THREAD_A);
    }
    tracker.clearThread(THREAD_A);
    NodeAssert.equal(tracker.isMalformed(THREAD_A), false);
  });
});
