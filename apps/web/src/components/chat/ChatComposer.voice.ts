import type { ProjectId, ProviderDriverKind } from "@shuv2code/contracts";

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
