import { describe, expect, it } from "vite-plus/test";

import { detectVoiceBrowserSupport } from "./voiceBrowserSupport";

describe("detectVoiceBrowserSupport", () => {
  it("rejects an insecure context before probing media or WebRTC APIs", () => {
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: false,
        mediaDevices: undefined,
        RTCPeerConnection: undefined,
      }),
    ).toEqual({
      supported: false,
      code: "insecure-context",
      message: "Voice control requires a secure connection.",
    });
  });

  it("reports missing microphone, peer connection, and data-channel support distinctly", () => {
    const getUserMedia = async () => ({}) as MediaStream;
    class PeerWithoutDataChannel {
      readonly unsupported = true;
    }
    class SupportedPeer {
      createDataChannel() {}
    }

    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: undefined,
        RTCPeerConnection: SupportedPeer as unknown as typeof RTCPeerConnection,
      }),
    ).toMatchObject({ supported: false, code: "media-devices-unavailable" });
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: { getUserMedia },
        RTCPeerConnection: undefined,
      }),
    ).toMatchObject({ supported: false, code: "webrtc-unavailable" });
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: { getUserMedia },
        RTCPeerConnection: PeerWithoutDataChannel as unknown as typeof RTCPeerConnection,
      }),
    ).toMatchObject({ supported: false, code: "data-channel-unavailable" });
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: { getUserMedia },
        RTCPeerConnection: SupportedPeer as unknown as typeof RTCPeerConnection,
      }),
    ).toEqual({ supported: true });
  });
});
