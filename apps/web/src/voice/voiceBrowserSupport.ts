export type VoiceBrowserUnsupportedCode =
  | "insecure-context"
  | "media-devices-unavailable"
  | "webrtc-unavailable"
  | "data-channel-unavailable";

export type VoiceBrowserSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly code: VoiceBrowserUnsupportedCode;
      readonly message: string;
    };

export interface VoiceBrowserSupportEnvironment {
  readonly isSecureContext: boolean;
  readonly mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined;
  readonly RTCPeerConnection: typeof globalThis.RTCPeerConnection | undefined;
}

export function detectVoiceBrowserSupport(
  environment: VoiceBrowserSupportEnvironment = {
    isSecureContext: globalThis.isSecureContext,
    mediaDevices: globalThis.navigator?.mediaDevices,
    RTCPeerConnection: globalThis.RTCPeerConnection,
  },
): VoiceBrowserSupport {
  if (!environment.isSecureContext) {
    return {
      supported: false,
      code: "insecure-context",
      message: "Voice control requires a secure connection.",
    };
  }
  if (!environment.mediaDevices?.getUserMedia) {
    return {
      supported: false,
      code: "media-devices-unavailable",
      message: "This browser cannot access a microphone.",
    };
  }
  if (!environment.RTCPeerConnection) {
    return {
      supported: false,
      code: "webrtc-unavailable",
      message: "This browser does not support the required WebRTC connection.",
    };
  }
  if (!environment.RTCPeerConnection.prototype.createDataChannel) {
    return {
      supported: false,
      code: "data-channel-unavailable",
      message: "This browser does not support realtime voice events.",
    };
  }
  return { supported: true };
}
