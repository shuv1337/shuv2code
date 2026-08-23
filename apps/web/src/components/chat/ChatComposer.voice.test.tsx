import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@shuv2code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { VoiceControlButtonProps } from "../voice/VoiceControlButton";

vi.mock("../voice/VoiceControlButton", () => ({
  VoiceControlButton: (props: VoiceControlButtonProps) => (
    <span
      data-voice-control="true"
      data-compact={String(props.compact)}
      data-environment-id={props.environmentId}
      data-host-project-id={props.hostProjectId}
      data-provider-instance-id={props.providerInstanceId}
      data-model={props.modelSelection.model}
      data-realtime-enabled={String(props.realtimeEnabled)}
      data-thread-read-enabled={String(props.threadReadEnabled)}
      data-thread-control-enabled={String(props.threadControlEnabled)}
    />
  ),
}));

import chatComposerSource from "./ChatComposer.tsx?raw";
import {
  ComposerVoiceControlMount,
  type ComposerVoiceControlMountProps,
  resolveVoiceControlHostProjectId,
} from "./ChatComposer.voice";

describe("resolveVoiceControlHostProjectId", () => {
  const projectId = ProjectId.make("project-1");

  it("exposes voice control for every available provider project", () => {
    for (const provider of ["codex", "claude", "opencode", "opencodeV2"] as const) {
      expect(
        resolveVoiceControlHostProjectId({
          activeProjectId: projectId,
          providerAvailable: true,
          selectedProvider: ProviderDriverKind.make(provider),
        }),
        provider,
      ).toBe(projectId);
    }
  });

  it("keeps voice control hidden without a project or available provider", () => {
    expect(
      resolveVoiceControlHostProjectId({
        activeProjectId: null,
        providerAvailable: true,
        selectedProvider: ProviderDriverKind.make("opencodeV2"),
      }),
    ).toBeNull();
    expect(
      resolveVoiceControlHostProjectId({
        activeProjectId: projectId,
        providerAvailable: false,
        selectedProvider: ProviderDriverKind.make("opencodeV2"),
      }),
    ).toBeNull();
  });
});

describe("ComposerVoiceControlMount", () => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  const props = {
    compact: true,
    environmentId: EnvironmentId.make("environment-1"),
    hostProjectId: ProjectId.make("project-1"),
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
    realtimeEnabled: true,
    threadReadEnabled: true,
    threadControlEnabled: false,
  } satisfies ComposerVoiceControlMountProps;

  it("renders voice control and forwards the current composer configuration", () => {
    const markup = renderToStaticMarkup(<ComposerVoiceControlMount {...props} />);

    expect(markup).toContain('data-voice-control="true"');
    expect(markup).toContain('data-compact="true"');
    expect(markup).toContain('data-environment-id="environment-1"');
    expect(markup).toContain('data-host-project-id="project-1"');
    expect(markup).toContain('data-provider-instance-id="codex"');
    expect(markup).toContain('data-model="gpt-5.6-sol"');
    expect(markup).toContain('data-realtime-enabled="true"');
    expect(markup).toContain('data-thread-read-enabled="true"');
    expect(markup).toContain('data-thread-control-enabled="false"');
  });

  it("does not render voice control without an eligible host project", () => {
    expect(
      renderToStaticMarkup(<ComposerVoiceControlMount {...props} hostProjectId={null} />),
    ).toBe("");
  });

  it("keeps the tested mount boundary in the composer action row", () => {
    const actionsStart = chatComposerSource.indexOf('data-chat-composer-actions="right"');
    const primaryActionsStart = chatComposerSource.indexOf(
      "<ComposerFooterPrimaryActions",
      actionsStart,
    );

    expect(actionsStart).toBeGreaterThan(-1);
    expect(primaryActionsStart).toBeGreaterThan(actionsStart);

    const actionsSource = chatComposerSource.slice(actionsStart, primaryActionsStart);
    expect(actionsSource).toContain("<ComposerVoiceControlMount");
    expect(actionsSource).toContain("environmentId={environmentId}");
    expect(actionsSource).toContain("hostProjectId={voiceControlHostProjectId}");
    expect(actionsSource).toContain("providerInstanceId={selectedInstanceId}");
    expect(actionsSource).toContain("modelSelection={selectedModelSelection}");
    expect(actionsSource).toContain("realtimeEnabled={settings.enableRealtimeVoice}");
    expect(actionsSource).toContain("threadReadEnabled={settings.enableVoiceThreadRead}");
    expect(actionsSource).toContain("threadControlEnabled={settings.enableVoiceThreadControl}");
  });
});
