import { ProjectId, ProviderDriverKind } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import chatComposerSource from "./ChatComposer.tsx?raw";
import { resolveVoiceControlHostProjectId } from "./ChatComposer.voice";

describe("resolveVoiceControlHostProjectId", () => {
  const projectId = ProjectId.make("project-1");

  it("exposes voice control for an available Codex project", () => {
    expect(
      resolveVoiceControlHostProjectId({
        activeProjectId: projectId,
        providerAvailable: true,
        selectedProvider: ProviderDriverKind.make("codex"),
      }),
    ).toBe(projectId);
  });

  it("keeps voice control hidden without a project or Codex provider", () => {
    expect(
      resolveVoiceControlHostProjectId({
        activeProjectId: null,
        providerAvailable: true,
        selectedProvider: ProviderDriverKind.make("codex"),
      }),
    ).toBeNull();
    expect(
      resolveVoiceControlHostProjectId({
        activeProjectId: projectId,
        providerAvailable: true,
        selectedProvider: ProviderDriverKind.make("claude"),
      }),
    ).toBeNull();
    expect(
      resolveVoiceControlHostProjectId({
        activeProjectId: projectId,
        providerAvailable: false,
        selectedProvider: ProviderDriverKind.make("codex"),
      }),
    ).toBeNull();
  });

  it("keeps voice control mounted with the current composer configuration", () => {
    const actionsStart = chatComposerSource.indexOf('data-chat-composer-actions="right"');
    const primaryActionsStart = chatComposerSource.indexOf(
      "<ComposerFooterPrimaryActions",
      actionsStart,
    );

    expect(actionsStart).toBeGreaterThan(-1);
    expect(primaryActionsStart).toBeGreaterThan(actionsStart);

    const actionsSource = chatComposerSource.slice(actionsStart, primaryActionsStart);
    expect(actionsSource).toContain("<VoiceControlButton");
    expect(actionsSource).toContain("environmentId={environmentId}");
    expect(actionsSource).toContain("hostProjectId={voiceControlHostProjectId}");
    expect(actionsSource).toContain("providerInstanceId={selectedInstanceId}");
    expect(actionsSource).toContain("modelSelection={selectedModelSelection}");
    expect(actionsSource).toContain("realtimeEnabled={settings.enableRealtimeVoice}");
    expect(actionsSource).toContain("threadReadEnabled={settings.enableVoiceThreadRead}");
    expect(actionsSource).toContain("threadControlEnabled={settings.enableVoiceThreadControl}");
  });
});
