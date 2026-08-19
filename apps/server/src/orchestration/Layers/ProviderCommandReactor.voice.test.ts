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
      callIdentity: {
        threadId: "thread-luna",
        threadTitle: "Identify Running Durable Agent",
        projectId: "project-1",
        durableProviderInstanceId: "opencode",
        durableModel: "opencode-go/gpt-5.6-luna",
        durableAgent: "build",
        transportProviderInstanceId: "codex",
        transportModel: "gpt-live-1-codex",
      },
      activeTranscript: [
        { role: "user", text: visible },
        { role: "assistant", text: "I'll inspect that now." },
        { role: "system", text: "ignored" },
      ],
    });
    expect(providerInput).toContain("<voice_call>");
    expect(providerInput).toContain("provider-neutral bounded sentence channel");
    expect(providerInput).not.toContain("voice_speak");
    expect(providerInput).toContain("Maintain conversational presence");
    expect(providerInput).toContain("commentary updates");
    expect(providerInput).toContain("roughly thirty seconds");
    expect(providerInput).toContain("Do not repeat an unchanged status");
    expect(providerInput).toContain("Speak blockers, approval requests");
    expect(providerInput).toContain("Keep code, logs, and long prose");
    expect(providerInput).toContain("Durable provider instance: opencode");
    expect(providerInput).toContain("Durable model: opencode-go/gpt-5.6-luna");
    expect(providerInput).toContain("Durable agent/profile: build");
    expect(providerInput).toContain("Realtime voice transport model: gpt-live-1-codex");
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
    expect(quiet).toContain("provider-neutral bounded sentence channel");

    expect(conversational).toContain("roughly fifteen seconds");
    expect(conversational).toContain("meaningful tool calls");
    expect(conversational).toContain("never read raw tool names");
    expect(conversational).toContain("provider-neutral bounded sentence channel");
  });
});
