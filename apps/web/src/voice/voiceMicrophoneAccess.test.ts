import { describe, expect, it, vi } from "vite-plus/test";

import { verifyVoiceMicrophoneAccess, VOICE_MICROPHONE_CONSTRAINTS } from "./voiceMicrophoneAccess";

describe("verifyVoiceMicrophoneAccess", () => {
  it("releases the permission probe before controller provisioning continues", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }, { stop }],
    })) as unknown as MediaDevices["getUserMedia"];

    await verifyVoiceMicrophoneAccess({ getUserMedia });

    expect(getUserMedia).toHaveBeenCalledWith(VOICE_MICROPHONE_CONSTRAINTS);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("normalizes denied microphone access into an actionable voice error", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    }) as unknown as MediaDevices["getUserMedia"];

    await expect(verifyVoiceMicrophoneAccess({ getUserMedia })).rejects.toMatchObject({
      code: "permission-denied",
      message: "Microphone access was denied. Allow microphone access and try again.",
    });
  });
});
