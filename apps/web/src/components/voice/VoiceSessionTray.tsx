import { MicIcon, MicOffIcon, PhoneOffIcon, RotateCcwIcon } from "lucide-react";

import {
  realtimeVoiceStateLabel,
  type RealtimeVoiceSessionState,
} from "@shuv2code/client-runtime/state/realtime-voice";
import { useRightPanelStore } from "../../rightPanelStore";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import { Button } from "../ui/button";
import { VoiceTargetStrip } from "./VoiceTargetStrip";
import { VoiceTranscript } from "./VoiceTranscript";

export function shouldShowVoiceTray(state: RealtimeVoiceSessionState): boolean {
  return state.phase.type !== "idle";
}

export function voiceTraySubtitle(state: RealtimeVoiceSessionState): string {
  return state.phase.type === "error" || state.phase.type === "unsupported"
    ? "Needs attention"
    : realtimeVoiceStateLabel(state);
}

export function VoiceSessionTray() {
  const voice = useVoiceSession();
  const voiceSurfaceOpen = useRightPanelStore((state) =>
    voice.state.environmentId
      ? state.byEnvironmentId[voice.state.environmentId]?.voiceActive === true
      : false,
  );
  if (!shouldShowVoiceTray(voice.state) || voiceSurfaceOpen) {
    return null;
  }
  const label = realtimeVoiceStateLabel(voice.state);
  const subtitle = voiceTraySubtitle(voice.state);
  const actionableError =
    voice.state.phase.type === "error" || voice.state.phase.type === "unsupported";

  return (
    <aside
      aria-label="Voice control"
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-[80] w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl motion-reduce:transition-none"
      data-voice-session-tray
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden="true"
        >
          {voice.state.muted ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {voice.state.controller?.title ?? "Voice control"}
          </p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {voice.state.environmentId ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => useRightPanelStore.getState().openVoice(voice.state.environmentId!)}
          >
            Open
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={voice.state.muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={voice.state.muted}
          disabled={actionableError}
          onClick={() => voice.setMuted(!voice.state.muted)}
        >
          {voice.state.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
        {voice.state.phase.type === "error" && voice.state.phase.recoverable ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Reconnect voice control"
            onClick={() => void voice.reconnect()}
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="destructive-outline"
          aria-label="End voice control"
          onClick={() => void voice.stop()}
        >
          <PhoneOffIcon />
        </Button>
      </div>
      {actionableError ? (
        <div className="border-border/60 border-t px-3 py-2">
          <p
            tabIndex={0}
            className="text-sm text-destructive-foreground"
            aria-live="polite"
            aria-atomic="true"
          >
            {label}
          </p>
        </div>
      ) : (
        <VoiceTranscript items={voice.state.transcript} />
      )}
      {voice.state.activeTarget ? <VoiceTargetStrip target={voice.state.activeTarget} /> : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {actionableError ? null : label}
      </div>
    </aside>
  );
}
