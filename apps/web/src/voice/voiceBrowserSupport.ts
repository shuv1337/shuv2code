export type VoiceBrowserUnsupportedCode =
  | "insecure-context"
  | "media-devices-unavailable"
  | "webrtc-unavailable"
  | "data-channel-unavailable"
  | "pcm-unavailable";

export type VoiceBrowserSupport =
  | {
      readonly supported: true;
      readonly webrtc: boolean;
      readonly pcm: boolean;
    }
  | {
      readonly supported: false;
      readonly code: VoiceBrowserUnsupportedCode;
      readonly message: string;
      readonly webrtc: boolean;
      readonly pcm: boolean;
    };

export interface VoiceBrowserSupportEnvironment {
  readonly isSecureContext: boolean;
  readonly mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined;
  readonly RTCPeerConnection: typeof globalThis.RTCPeerConnection | undefined;
  readonly AudioContext: typeof globalThis.AudioContext | undefined;
  readonly AudioWorkletNode: typeof globalThis.AudioWorkletNode | undefined;
}

export function detectVoiceBrowserSupport(
  environment: VoiceBrowserSupportEnvironment = {
    isSecureContext: globalThis.isSecureContext,
    mediaDevices: globalThis.navigator?.mediaDevices,
    RTCPeerConnection: globalThis.RTCPeerConnection,
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
  },
): VoiceBrowserSupport {
  const mediaOk = Boolean(environment.mediaDevices?.getUserMedia);
  const webrtc = Boolean(
    environment.RTCPeerConnection && environment.RTCPeerConnection.prototype.createDataChannel,
  );
  const pcm = Boolean(environment.AudioContext && environment.AudioWorkletNode && mediaOk);

  if (!environment.isSecureContext) {
    return {
      supported: false,
      code: "insecure-context",
      message: "Voice control requires a secure connection.",
      webrtc: false,
      pcm: false,
    };
  }
  if (!mediaOk) {
    return {
      supported: false,
      code: "media-devices-unavailable",
      message: "This browser cannot access a microphone.",
      webrtc: false,
      pcm: false,
    };
  }
  if (webrtc || pcm) {
    return { supported: true, webrtc, pcm };
  }
  if (!environment.RTCPeerConnection) {
    return {
      supported: false,
      code: "webrtc-unavailable",
      message: "This browser does not support WebRTC or PCM voice fallback.",
      webrtc: false,
      pcm: false,
    };
  }
  return {
    supported: false,
    code: "data-channel-unavailable",
    message: "This browser does not support realtime voice events.",
    webrtc: false,
    pcm: false,
  };
}
