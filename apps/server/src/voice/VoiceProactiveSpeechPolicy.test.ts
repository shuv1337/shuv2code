import { assert, describe, it } from "@effect/vitest";

import {
  PROACTIVE_SPEECH_COOLDOWN_MS,
  PROACTIVE_SPEECH_MAX_CHARS,
  boundProactiveSpeechText,
  decideProactiveSpeech,
  isSpeakableTargetPhase,
  rememberProactiveSpeech,
} from "./VoiceProactiveSpeechPolicy.ts";

describe("VoiceProactiveSpeechPolicy", () => {
  it("bounds and normalizes speakable text", () => {
    assert.strictEqual(boundProactiveSpeechText("  hello   world  "), "hello world");
    assert.strictEqual(
      boundProactiveSpeechText("x".repeat(2_000)).length,
      PROACTIVE_SPEECH_MAX_CHARS,
    );
  });

  it("speaks only actionable target phases", () => {
    assert.strictEqual(isSpeakableTargetPhase("completed"), true);
    assert.strictEqual(isSpeakableTargetPhase("failed"), true);
    assert.strictEqual(isSpeakableTargetPhase("waiting_for_approval"), true);
    assert.strictEqual(isSpeakableTargetPhase("waiting_for_input"), true);
    assert.strictEqual(isSpeakableTargetPhase("working"), false);
    assert.strictEqual(isSpeakableTargetPhase("starting"), false);
    assert.strictEqual(isSpeakableTargetPhase("ready"), false);
  });

  it("rejects empty, unspeakable, duplicate, and stale-generation speech", () => {
    const base = {
      kind: "target_phase" as const,
      text: "Target is waiting for approval.",
      transportSessionId: "transport-1",
      generation: 3,
      nowMs: 10_000,
      memory: new Map(),
      targetThreadId: "target-1",
      phase: "waiting_for_approval" as const,
    };
    assert.strictEqual(decideProactiveSpeech({ ...base, text: "   " }).reason, "empty");
    assert.strictEqual(
      decideProactiveSpeech({ ...base, phase: "working" }).reason,
      "phase_not_speakable",
    );
    assert.strictEqual(
      decideProactiveSpeech({ ...base, expectedGeneration: 2 }).reason,
      "generation_mismatch",
    );
    const memory = new Map();
    const first = decideProactiveSpeech({ ...base, memory });
    assert.strictEqual(first.speak, true);
    rememberProactiveSpeech(memory, {
      kind: base.kind,
      text: first.text,
      transportSessionId: base.transportSessionId,
      generation: base.generation,
      nowMs: base.nowMs,
      targetThreadId: base.targetThreadId,
      phase: base.phase,
    });
    assert.strictEqual(decideProactiveSpeech({ ...base, memory }).reason, "duplicate");
  });

  it("enforces cooldown across rapid distinct target updates", () => {
    const memory = new Map();
    const first = decideProactiveSpeech({
      kind: "target_phase",
      text: "Target is waiting for approval.",
      transportSessionId: "t1",
      generation: 1,
      nowMs: 1_000,
      memory,
      targetThreadId: "a",
      phase: "waiting_for_approval",
    });
    assert.strictEqual(first.speak, true);
    rememberProactiveSpeech(memory, {
      kind: "target_phase",
      text: first.text,
      transportSessionId: "t1",
      generation: 1,
      nowMs: 1_000,
      targetThreadId: "a",
      phase: "waiting_for_approval",
    });
    const second = decideProactiveSpeech({
      kind: "target_phase",
      text: "Target failed.",
      transportSessionId: "t1",
      generation: 1,
      nowMs: 1_000 + PROACTIVE_SPEECH_COOLDOWN_MS - 1,
      memory,
      targetThreadId: "b",
      phase: "failed",
    });
    assert.strictEqual(second.reason, "cooldown");
    const after = decideProactiveSpeech({
      kind: "target_phase",
      text: "Target failed.",
      transportSessionId: "t1",
      generation: 1,
      nowMs: 1_000 + PROACTIVE_SPEECH_COOLDOWN_MS,
      memory,
      targetThreadId: "b",
      phase: "failed",
    });
    assert.strictEqual(after.speak, true);
  });

  it("speaks controller terminal completion and failure", () => {
    const decision = decideProactiveSpeech({
      kind: "controller_action_completed",
      text: "The controller action completed.",
      transportSessionId: "t1",
      generation: 1,
      nowMs: 5_000,
      memory: new Map(),
      voiceActionId: "action-1",
    });
    assert.strictEqual(decision.speak, true);
    assert.strictEqual(decision.text, "The controller action completed.");
  });
});
