import { normalizeVoiceSessionError } from "./voiceErrors";

export const VOICE_MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

export async function verifyVoiceMicrophoneAccess(
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined = globalThis.navigator?.mediaDevices,
): Promise<void> {
  if (!mediaDevices) {
    throw normalizeVoiceSessionError(
      new DOMException("Microphone access is unavailable.", "NotFoundError"),
    );
  }
  try {
    const stream = await mediaDevices.getUserMedia(VOICE_MICROPHONE_CONSTRAINTS);
    for (const track of stream.getTracks()) {
      track.stop();
    }
  } catch (error) {
    throw normalizeVoiceSessionError(error);
  }
}
