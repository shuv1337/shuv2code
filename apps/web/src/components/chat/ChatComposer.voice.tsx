import type { ProjectId, ProviderDriverKind } from "@shuv2code/contracts";

import { VoiceControlButton, type VoiceControlButtonProps } from "../voice/VoiceControlButton";

export function resolveVoiceControlHostProjectId(input: {
  readonly activeProjectId: ProjectId | null | undefined;
  readonly providerAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
}): ProjectId | null {
  if (!input.activeProjectId || !input.providerAvailable || input.selectedProvider !== "codex") {
    return null;
  }
  return input.activeProjectId;
}

export type ComposerVoiceControlMountProps = Omit<VoiceControlButtonProps, "hostProjectId"> & {
  readonly hostProjectId: ProjectId | null;
};

export function ComposerVoiceControlMount(props: ComposerVoiceControlMountProps) {
  const { hostProjectId, ...buttonProps } = props;
  if (!hostProjectId) return null;

  return <VoiceControlButton {...buttonProps} hostProjectId={hostProjectId} />;
}
