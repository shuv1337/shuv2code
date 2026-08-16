import {
  MessageSquareTextIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";

import {
  realtimeVoiceStateLabel,
  type RealtimeVoiceSessionState,
} from "@shuv2code/client-runtime/state/realtime-voice";
import { useRightPanelStore } from "../../rightPanelStore";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import { Button } from "../ui/button";
import { VoiceActionStatusStrip } from "./VoiceActionStatusStrip";
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

export function voiceTrayTitle(state: RealtimeVoiceSessionState): string {
  if (state.owner?.kind !== "thread-call") return "Voice session";
  return state.controller?.title ?? "Active call";
}

export function VoiceSessionTray() {
  const voice = useVoiceSession();
  const navigate = useNavigate();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
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
  const title = voiceTrayTitle(voice.state);
  const actionableError =
    voice.state.phase.type === "error" || voice.state.phase.type === "unsupported";
  const callPresentation =
    voice.state.owner?.kind === "thread-call" ? voice.state.controller : null;
  const viewingCallThread =
    callPresentation !== null &&
    routeThreadRef?.environmentId === callPresentation.environmentId &&
    routeThreadRef.threadId === callPresentation.threadId;

  const goToCallThread = () => {
    if (callPresentation === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: callPresentation.environmentId,
        threadId: callPresentation.threadId,
      },
    });
  };

  return (
    <aside
      aria-label="Call controls"
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-[80] w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl motion-reduce:transition-none"
      data-voice-session-tray
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden="true"
        >
          {voice.state.muted ? (
            <MicOffIcon className="size-4" />
          ) : callPresentation !== null ? (
            <PhoneIcon className="size-4" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
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
        {callPresentation !== null && !viewingCallThread ? (
          <Button size="xs" variant="ghost" onClick={goToCallThread}>
            <MessageSquareTextIcon />
            Thread
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
            aria-label="Reconnect call"
            onClick={() => void voice.reconnect()}
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="destructive-outline"
          aria-label="End call"
          onClick={() => void voice.stop()}
        >
          <PhoneOffIcon />
        </Button>
      </div>
      {voice.state.controllerAction ? (
        <VoiceActionStatusStrip action={voice.state.controllerAction} />
      ) : null}
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
