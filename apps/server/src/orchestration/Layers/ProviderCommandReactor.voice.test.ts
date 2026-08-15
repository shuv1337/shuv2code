import { describe, expect, it } from "vite-plus/test";

import { voiceCallProviderInput } from "./ProviderCommandReactor.ts";

describe("voice Call provider input", () => {
  it("keeps ordinary input unchanged outside a voice handoff", () => {
    expect(voiceCallProviderInput("Inspect the provider.", undefined)).toBe(
      "Inspect the provider.",
    );
  });

  it("adds bounded hidden call context without changing the durable message", () => {
    const visible = "Inspect the provider.";
    const providerInput = voiceCallProviderInput(visible, {
      actorKind: "voice-call",
      activeTranscript: [
        { role: "user", text: visible },
        { role: "assistant", text: "I'll inspect that now." },
        { role: "system", text: "ignored" },
      ],
    });
    expect(providerInput).toContain("<voice_call>");
    expect(providerInput).toContain("MUST call voice_speak");
    expect(providerInput).toContain("Maintain conversational presence");
    expect(providerInput).toContain("useful commentary update");
    expect(providerInput).toContain("roughly thirty seconds");
    expect(providerInput).toContain("Do not repeat an unchanged status");
    expect(providerInput).toContain("Speak blockers, approval requests");
    expect(providerInput).toContain("do not return a text-only answer");
    expect(providerInput).toContain("assistant: I'll inspect that now.");
    expect(providerInput).not.toContain("system: ignored");
    expect(providerInput.endsWith(`User request:\n${visible}`)).toBe(true);
    expect(visible).toBe("Inspect the provider.");
  });

  it("configures routine narration without weakening blocker and completion speech", () => {
    const provenance = { actorKind: "voice-call" };
    const quiet = voiceCallProviderInput("Inspect it.", provenance, "quiet");
    const conversational = voiceCallProviderInput("Inspect it.", provenance, "conversational");

    expect(quiet).toContain("Keep routine tool progress quiet");
    expect(quiet).not.toContain("roughly thirty seconds");
    expect(quiet).toContain("Speak blockers, approval requests");
    expect(quiet).toContain("MUST call voice_speak");

    expect(conversational).toContain("roughly fifteen seconds");
    expect(conversational).toContain("meaningful tool calls");
    expect(conversational).toContain("never read raw tool names");
    expect(conversational).toContain("MUST call voice_speak");
  });
});
