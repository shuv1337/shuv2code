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

interface VoiceControllerReplacementWorkflow<T> {
  readonly acquireMicrophone: () => Promise<T>;
  readonly resetController: () => Promise<boolean>;
  readonly startWithMicrophone: (microphone: T) => Promise<void>;
  readonly releaseMicrophone: (microphone: T) => void;
}

export async function replaceVoiceControllerAfterMicrophoneAccess<T>(
  workflow: VoiceControllerReplacementWorkflow<T>,
): Promise<void> {
  const microphone = await workflow.acquireMicrophone();
  let transferred = false;
  try {
    const reset = await workflow.resetController();
    if (!reset) {
      throw new Error("The controller changed before it could be reset. Refresh and try again.");
    }
    transferred = true;
    await workflow.startWithMicrophone(microphone);
  } finally {
    if (!transferred) {
      workflow.releaseMicrophone(microphone);
    }
  }
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
