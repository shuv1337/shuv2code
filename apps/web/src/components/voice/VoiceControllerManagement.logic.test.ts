import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VoiceControllerIdentity,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasVoiceControllerBindingConflict,
  voiceControllerStateLabel,
} from "./VoiceControllerManagement.logic";

const controller: VoiceControllerIdentity = {
  controllerThreadId: ThreadId.make("voice-controller"),
  hostProjectId: ProjectId.make("project-a"),
  providerInstanceId: ProviderInstanceId.make("provider-a"),
  authorizedRuntimeCeiling: "approval-required",
  bindingGeneration: 1,
  controlEpoch: 0,
  state: "active",
};

describe("voice controller management", () => {
  it("requires reauthorization when host, provider, or ceiling changes", () => {
    expect(
      hasVoiceControllerBindingConflict(controller, {
        hostProjectId: controller.hostProjectId,
        providerInstanceId: controller.providerInstanceId,
        authorizedRuntimeCeiling: controller.authorizedRuntimeCeiling,
      }),
    ).toBe(false);
    expect(
      hasVoiceControllerBindingConflict(controller, {
        hostProjectId: ProjectId.make("project-b"),
        providerInstanceId: controller.providerInstanceId,
        authorizedRuntimeCeiling: controller.authorizedRuntimeCeiling,
      }),
    ).toBe(true);
    expect(
      hasVoiceControllerBindingConflict(controller, {
        hostProjectId: controller.hostProjectId,
        providerInstanceId: ProviderInstanceId.make("provider-b"),
        authorizedRuntimeCeiling: controller.authorizedRuntimeCeiling,
      }),
    ).toBe(true);
    expect(
      hasVoiceControllerBindingConflict(controller, {
        hostProjectId: controller.hostProjectId,
        providerInstanceId: controller.providerInstanceId,
        authorizedRuntimeCeiling: "full-access",
      }),
    ).toBe(true);
  });

  it("does not report a conflict when no controller is bound", () => {
    expect(
      hasVoiceControllerBindingConflict(null, {
        hostProjectId: controller.hostProjectId,
        providerInstanceId: controller.providerInstanceId,
        authorizedRuntimeCeiling: controller.authorizedRuntimeCeiling,
      }),
    ).toBe(false);
  });

  it("uses human-readable binding states", () => {
    expect(voiceControllerStateLabel("active")).toBe("Active");
    expect(voiceControllerStateLabel("dormant")).toBe("Ready to reconnect");
  });
});
