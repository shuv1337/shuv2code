import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VoiceControllerIdentity,
} from "@shuv2code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  hasVoiceControllerBindingConflict,
  replaceVoiceControllerAfterMicrophoneAccess,
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

  it("does not reset when microphone acquisition fails", async () => {
    const resetController = vi.fn();
    const startWithMicrophone = vi.fn();

    await expect(
      replaceVoiceControllerAfterMicrophoneAccess({
        acquireMicrophone: async () => {
          throw new Error("permission denied");
        },
        resetController,
        startWithMicrophone,
        releaseMicrophone: vi.fn(),
      }),
    ).rejects.toThrow("permission denied");
    expect(resetController).not.toHaveBeenCalled();
    expect(startWithMicrophone).not.toHaveBeenCalled();
  });

  it("releases the microphone and never starts when the reset fence is stale", async () => {
    const microphone = { id: "microphone" };
    const releaseMicrophone = vi.fn();
    const startWithMicrophone = vi.fn();

    await expect(
      replaceVoiceControllerAfterMicrophoneAccess({
        acquireMicrophone: async () => microphone,
        resetController: async () => false,
        startWithMicrophone,
        releaseMicrophone,
      }),
    ).rejects.toThrow("The controller changed before it could be reset");
    expect(releaseMicrophone).toHaveBeenCalledWith(microphone);
    expect(startWithMicrophone).not.toHaveBeenCalled();
  });

  it("acquires, resets, then transfers the single microphone to startup", async () => {
    const order: string[] = [];
    const microphone = { id: "microphone" };
    const releaseMicrophone = vi.fn();

    await replaceVoiceControllerAfterMicrophoneAccess({
      acquireMicrophone: async () => {
        order.push("acquire");
        return microphone;
      },
      resetController: async () => {
        order.push("reset");
        return true;
      },
      startWithMicrophone: async (received) => {
        order.push("start");
        expect(received).toBe(microphone);
      },
      releaseMicrophone,
    });

    expect(order).toEqual(["acquire", "reset", "start"]);
    expect(releaseMicrophone).not.toHaveBeenCalled();
  });
});
