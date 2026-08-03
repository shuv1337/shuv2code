import { describe, expect, it, vi } from "vite-plus/test";

import {
  acquireVoiceMicrophoneStream,
  releaseVoiceMicrophoneStream,
  VOICE_MICROPHONE_CONSTRAINTS,
} from "./voiceMicrophoneAccess";

const supported = { supported: true, webrtc: true, pcm: false } as const;

describe("acquireVoiceMicrophoneStream", () => {
  it("returns one stream whose ownership can be released by the caller", async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }, { stop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream) as unknown as MediaDevices["getUserMedia"];

    const acquired = await acquireVoiceMicrophoneStream({ getUserMedia }, supported);

    expect(acquired).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith(VOICE_MICROPHONE_CONSTRAINTS);
    expect(stop).not.toHaveBeenCalled();
    releaseVoiceMicrophoneStream(acquired);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("normalizes denied microphone access into an actionable voice error", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    }) as unknown as MediaDevices["getUserMedia"];

    await expect(acquireVoiceMicrophoneStream({ getUserMedia }, supported)).rejects.toMatchObject({
      code: "permission-denied",
      message: "Microphone access was denied. Allow microphone access and try again.",
    });
  });

  it("rejects unsupported browsers before asking for microphone permission", async () => {
    const getUserMedia = vi.fn();

    await expect(
      acquireVoiceMicrophoneStream(
        { getUserMedia },
        {
          supported: false,
          code: "insecure-context",
          message: "Voice control requires a secure connection.",
          webrtc: false,
          pcm: false,
        },
      ),
    ).rejects.toMatchObject({ code: "insecure-context" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
