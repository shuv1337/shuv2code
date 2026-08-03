import type {
  ProviderInstanceId,
  ProjectId,
  RuntimeMode,
  VoiceControllerIdentity,
} from "@shuv2code/contracts";

export interface RequestedVoiceControllerConfiguration {
  readonly hostProjectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly authorizedRuntimeCeiling: RuntimeMode;
}

export function hasVoiceControllerBindingConflict(
  controller: VoiceControllerIdentity | null,
  requested: RequestedVoiceControllerConfiguration,
): boolean {
  return (
    controller !== null &&
    (controller.hostProjectId !== requested.hostProjectId ||
      controller.providerInstanceId !== requested.providerInstanceId ||
      controller.authorizedRuntimeCeiling !== requested.authorizedRuntimeCeiling)
  );
}

export function voiceControllerStateLabel(state: VoiceControllerIdentity["state"]): string {
  switch (state) {
    case "provisioning":
      return "Starting";
    case "active":
      return "Active";
    case "dormant":
      return "Ready to reconnect";
    case "resetting":
      return "Resetting";
  }
}
