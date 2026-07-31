/**
 * Platform-neutral realtime voice media transport. Implementations live in
 * web/mobile apps; this package only owns the lifecycle contract.
 */
export type RealtimeVoiceTransportKind = "webrtc" | "websocket" | "unsupported";

export interface RealtimeVoiceTransportCapabilities {
  readonly webrtc: boolean;
  readonly pcmWorklet: boolean;
  readonly mediaDevices: boolean;
}

export interface RealtimeVoiceTransportStartResult {
  readonly kind: Exclude<RealtimeVoiceTransportKind, "unsupported">;
  readonly answerSdp?: string | null;
}

export interface RealtimeVoiceTransport {
  readonly kind: RealtimeVoiceTransportKind;
  readonly start: () => Promise<RealtimeVoiceTransportStartResult>;
  readonly stop: () => Promise<void>;
  readonly setMuted?: (muted: boolean) => void;
}

export function selectRealtimeVoiceTransportKind(
  capabilities: RealtimeVoiceTransportCapabilities,
  preferPcm = false,
): RealtimeVoiceTransportKind {
  if (!preferPcm && capabilities.webrtc) return "webrtc";
  if (capabilities.pcmWorklet && capabilities.mediaDevices) return "websocket";
  if (capabilities.webrtc) return "webrtc";
  return "unsupported";
}
