import { detectVoiceBrowserSupport, type VoiceBrowserSupport } from "./voiceBrowserSupport";
import { normalizeVoiceSessionError, VoiceSessionError } from "./voiceErrors";

export const VOICE_MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

export async function acquireVoiceMicrophoneStream(
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined = globalThis.navigator?.mediaDevices,
  support: VoiceBrowserSupport = detectVoiceBrowserSupport(),
): Promise<MediaStream> {
  if (!support.supported) {
    throw new VoiceSessionError(support.code, support.message);
  }
  if (!mediaDevices?.getUserMedia) {
    throw new VoiceSessionError(
      "media-devices-unavailable",
      "This browser cannot access a microphone.",
    );
  }
  try {
    return await mediaDevices.getUserMedia(VOICE_MICROPHONE_CONSTRAINTS);
  } catch (error) {
    throw normalizeVoiceSessionError(error);
  }
}

export function releaseVoiceMicrophoneStream(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}
