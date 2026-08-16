import { realtimeVoiceStateLabel } from "@shuv2code/client-runtime/state/realtime-voice";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceCallPresence,
} from "@shuv2code/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRightIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  Settings2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import {
  acquireVoiceMicrophoneStream,
  releaseVoiceMicrophoneStream,
} from "../../voice/voiceMicrophoneAccess";
import { Button } from "../ui/button";
import { VoicePresence } from "./VoicePresence";
import { deriveVoicePresenceIdentity } from "./voicePresenceIdentity";
import {
  isVoiceCallContextAvailable,
  resolveVoiceCallContext,
  resolveVoiceCallPresentation,
  resolveVoicePresencePhase,
} from "./VoiceSurface.logic";
import { voicePhaseStyle } from "./voicePresenceTheme";

type ActiveCallLookup =
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly call: VoiceCallPresence | null }
  | { readonly type: "error"; readonly message: string };

export interface VoiceSurfaceSetup {
  readonly hostProjectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly realtimeEnabled: boolean;
  readonly threadReadEnabled: boolean;
  readonly threadControlEnabled: boolean;
}

export interface VoiceSurfaceContext {
  readonly threadId: ThreadId | null;
  readonly threadTitle: string;
  readonly projectTitle: string;
  readonly projectId?: ProjectId;
}

export interface VoiceSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly currentContext: VoiceSurfaceContext;
  readonly setup: VoiceSurfaceSetup | null;
  readonly onMaterializeThreadForCall?: () => Promise<VoiceSurfaceContext>;
  readonly presented?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Call could not be prepared.";
}

function latestTranscript(
  items: ReturnType<typeof useVoiceSession>["state"]["transcript"],
  speaker: "user" | "assistant",
): string {
  return (
    [...items].toReversed().find((item) => item.speaker === speaker && item.text.trim().length > 0)
      ?.text ?? ""
  );
}

function VoiceCallSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly callEnvironmentId: EnvironmentId;
  readonly callContext: VoiceSurfaceContext;
  readonly viewedContext: VoiceSurfaceContext;
  readonly setup: VoiceSurfaceSetup | null;
  readonly sessionHere: boolean;
  readonly sessionActive: boolean;
  readonly otherSessionActive: boolean;
  readonly callAvailable: boolean;
  readonly remoteCall: VoiceCallPresence | null;
  readonly presented: boolean;
  readonly onMaterializeThreadForCall?: () => Promise<VoiceSurfaceContext>;
}) {
  const voice = useVoiceSession();
  const navigate = useNavigate();
  const presenceSettings = usePrimarySettings((settings) => ({
    contextTint: settings.voicePresenceContextTint,
    variation: settings.voicePresenceVariation,
  }));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const phase = resolveVoicePresencePhase(
    props.sessionHere,
    voice.state.phase,
    voice.state.muted,
    voice.mediaActivity,
  );
  const identity = useMemo(
    () =>
      deriveVoicePresenceIdentity({
        threadId: props.callContext.threadId,
        providerKey: props.setup?.providerInstanceId ?? null,
        projectKey:
          props.callContext.projectId ??
          props.setup?.hostProjectId ??
          props.callContext.projectTitle,
        contextTint: presenceSettings.contextTint,
        variation: presenceSettings.variation,
      }),
    [
      presenceSettings.contextTint,
      presenceSettings.variation,
      props.callContext.projectId,
      props.callContext.projectTitle,
      props.callContext.threadId,
      props.setup?.hostProjectId,
      props.setup?.providerInstanceId,
    ],
  );
  const assistantText = latestTranscript(voice.state.transcript, "assistant");
  const userText = latestTranscript(voice.state.transcript, "user");
  const activityText = voice.state.controllerAction?.statusText ?? "Working in this thread…";
  const temporal =
    phase === "speaking"
      ? { label: "Speaking", text: assistantText || "Preparing a response…" }
      : phase === "thinking"
        ? { label: "Working", text: activityText }
        : phase === "muted"
          ? { label: "Muted", text: "Incoming audio remains on." }
          : phase === "listening"
            ? { label: "Listening", text: userText || "Go ahead…" }
            : null;

  const startCall = async (
    context = props.viewedContext,
    options?: Pick<VoiceCallPresence, "callId"> & {
      readonly takeover: NonNullable<VoiceCallPresence["activeTransportSessionId"]>;
      readonly revision: VoiceCallPresence["revision"];
    },
    replaceCurrent = false,
  ) => {
    const setup = props.setup;
    if (setup === null || starting) return;
    setStarting(true);
    setStartError(null);
    let microphoneStream: MediaStream | undefined;
    try {
      const callContext = await resolveVoiceCallContext(context, props.onMaterializeThreadForCall);
      const threadId = callContext.threadId;
      if (threadId === null) {
        throw new Error("This thread could not be created for the Call.");
      }
      if (
        replaceCurrent ||
        voice.state.phase.type === "error" ||
        voice.state.phase.type === "unsupported"
      ) {
        await voice.stop();
      }
      microphoneStream = await acquireVoiceMicrophoneStream();
      const preparedMicrophone = microphoneStream;
      microphoneStream = undefined;
      await voice.start({
        environmentId: props.environmentId,
        owner: {
          kind: "thread-call",
          threadId,
          threadTitle: callContext.threadTitle,
        },
        hostProjectId: setup.hostProjectId,
        providerInstanceId: setup.providerInstanceId,
        modelSelection: setup.modelSelection,
        authorizedRuntimeCeiling: "approval-required",
        microphoneStream: preparedMicrophone,
        ...(options === undefined
          ? {}
          : {
              takeover: {
                callId: options.callId,
                expectedRevision: options.revision,
                expectedTransportSessionId: options.takeover,
              },
            }),
      });
    } catch (error) {
      setStartError(errorMessage(error));
    } finally {
      releaseVoiceMicrophoneStream(microphoneStream);
      setStarting(false);
    }
  };
  const callDiffersFromView =
    props.sessionActive &&
    (props.callEnvironmentId !== props.environmentId ||
      props.callContext.threadId !== props.viewedContext.threadId);
  const remoteCallHere =
    props.remoteCall !== null &&
    props.remoteCall.environmentId === props.environmentId &&
    props.remoteCall.threadId === props.viewedContext.threadId;

  const returnToCallThread = () => {
    const threadId = props.callContext.threadId;
    if (threadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: props.callEnvironmentId, threadId },
    });
  };

  const moveCallToViewedThread = async () => {
    if (starting) return;
    await startCall(props.viewedContext, undefined, true);
  };

  const continueRemoteCall = async () => {
    const call = props.remoteCall;
    if (!call || !remoteCallHere || call.activeTransportSessionId === null) return;
    await startCall(props.viewedContext, {
      callId: call.callId,
      takeover: call.activeTransportSessionId,
      revision: call.revision,
    });
  };

  return (
    <div
      className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden"
      style={voicePhaseStyle(phase, identity)}
    >
      <VoicePresence
        phase={phase}
        identity={identity}
        presented={props.presented}
        activityLevel={voice.activityLevel}
      />
      <div className="relative z-10 border-border/50 border-b px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--voice-accent)_12%,transparent)] text-[var(--voice-accent)] transition-colors duration-700">
            <PhoneIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold tracking-wide text-[var(--voice-accent)] uppercase">
              {props.sessionActive || props.remoteCall !== null ? "In call" : "Call this thread"}
            </p>
            <h2 className="truncate text-sm font-semibold">{props.callContext.threadTitle}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {props.callContext.projectTitle}
            </p>
          </div>
        </div>
        {callDiffersFromView ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-background/45 px-2.5 py-2">
            <MessageSquareTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-medium text-muted-foreground uppercase">Viewing</p>
              <p className="truncate text-xs font-medium">{props.viewedContext.threadTitle}</p>
            </div>
            <Button size="xs" variant="ghost" onClick={returnToCallThread}>
              Return
            </Button>
            {props.callAvailable && props.setup !== null ? (
              <Button
                size="xs"
                variant="outline"
                disabled={starting}
                onClick={() => void moveCallToViewedThread()}
              >
                <ArrowLeftRightIcon />
                Move call
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-end px-5 pb-[clamp(5rem,12vh,8rem)]">
        {props.sessionActive ? (
          temporal ? (
            <div className="min-h-24 w-full max-w-sm text-center" aria-live="polite">
              <p className="text-[11px] font-medium text-[var(--voice-accent)]">{temporal.label}</p>
              <p className="mt-1 line-clamp-4 text-sm leading-relaxed text-foreground">
                {temporal.text}
              </p>
            </div>
          ) : null
        ) : (
          <div className="max-w-sm text-center">
            <p className="text-sm font-medium">
              {props.remoteCall !== null
                ? `Call active on ${props.remoteCall.activeDevice?.label ?? "another device"}`
                : props.otherSessionActive
                  ? "Another voice session is active"
                  : props.callAvailable
                    ? "Ready to join"
                    : "Call unavailable"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {props.remoteCall !== null
                ? remoteCallHere
                  ? "Continue here to transfer audio from the other device."
                  : "Go to the owning thread before continuing on this device."
                : props.otherSessionActive
                  ? "End it before starting a Call in this thread."
                  : props.callAvailable
                    ? "The Call and its transcript stay with this thread."
                    : "Open a thread before starting a Call."}
            </p>
            {startError || (props.sessionHere && voice.state.phase.type === "error") ? (
              <p className="mt-3 text-xs text-destructive-foreground" role="alert">
                {startError ??
                  (voice.state.phase.type === "error" ? voice.state.phase.message : null)}
              </p>
            ) : null}
            {props.remoteCall !== null ? (
              <Button
                className="mt-4"
                size="sm"
                disabled={starting}
                onClick={() => (remoteCallHere ? void continueRemoteCall() : returnToCallThread())}
              >
                {starting ? <LoaderCircleIcon className="animate-spin" /> : <ArrowLeftRightIcon />}
                {starting ? "Moving…" : remoteCallHere ? "Continue here" : "Go to call thread"}
              </Button>
            ) : props.callAvailable && props.setup && !props.otherSessionActive ? (
              <Button
                className="mt-4"
                size="sm"
                disabled={starting}
                onClick={() => void startCall(props.viewedContext)}
              >
                {starting ? <LoaderCircleIcon className="animate-spin" /> : <PhoneIcon />}
                {starting ? "Joining…" : "Join call"}
              </Button>
            ) : props.otherSessionActive ? (
              <Button
                className="mt-4"
                size="sm"
                variant="outline"
                onClick={() => void voice.stop()}
              >
                <PhoneOffIcon />
                End voice session
              </Button>
            ) : (
              <Button
                className="mt-4"
                size="sm"
                variant="outline"
                render={<Link to="/settings/speech" />}
              >
                Voice settings
              </Button>
            )}
          </div>
        )}
      </div>

      {props.sessionActive ? (
        <div className="relative z-10 shrink-0 pb-4">
          <div className="mb-3 flex items-center justify-center gap-2 text-xs">
            <span className="size-2 rounded-full bg-[var(--voice-accent)] transition-colors duration-700" />
            <span className="font-medium">
              {phase === "muted"
                ? "Muted"
                : phase === "thinking"
                  ? "Working"
                  : phase === "speaking"
                    ? "Speaking"
                    : "Listening"}
            </span>
          </div>
          <div className="mx-auto flex items-center justify-center gap-5">
            <Button
              className="size-14 rounded-full border border-foreground/35 bg-background/48 text-foreground shadow-none"
              variant="ghost"
              size="icon"
              onClick={() => voice.setMuted(!voice.state.muted)}
              aria-label={voice.state.muted ? "Unmute" : "Mute"}
            >
              {voice.state.muted ? (
                <MicOffIcon className="size-5" />
              ) : (
                <MicIcon className="size-5" />
              )}
            </Button>
            <Button
              className="size-14 rounded-full"
              variant="destructive"
              size="icon"
              onClick={() => void voice.stop()}
              aria-label="End call"
            >
              <PhoneOffIcon className="size-5" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function VoiceSurface({
  environmentId,
  currentContext,
  setup,
  onMaterializeThreadForCall,
  presented = true,
}: VoiceSurfaceProps) {
  const voice = useVoiceSession();
  const [activeCall, setActiveCall] = useState<ActiveCallLookup>({ type: "loading" });
  const sessionHere = voice.state.environmentId === environmentId;
  const sessionActive =
    sessionHere &&
    voice.state.phase.type !== "idle" &&
    voice.state.phase.type !== "error" &&
    voice.state.phase.type !== "unsupported";
  const callPresentation = resolveVoiceCallPresentation(environmentId, voice.state, currentContext);
  const callSessionHere = callPresentation.sessionHere;
  const callSessionActive =
    callSessionHere &&
    voice.state.phase.type !== "idle" &&
    voice.state.phase.type !== "error" &&
    voice.state.phase.type !== "unsupported";
  const callAvailable = isVoiceCallContextAvailable(currentContext, onMaterializeThreadForCall);

  const loadActiveCall = useCallback(async () => {
    setActiveCall({ type: "loading" });
    try {
      setActiveCall({ type: "ready", call: await voice.getActiveCall(environmentId) });
    } catch (error) {
      setActiveCall({ type: "error", message: errorMessage(error) });
    }
  }, [environmentId, voice.getActiveCall]);

  useEffect(() => {
    void loadActiveCall();
  }, [loadActiveCall, voice.state.generation, voice.state.phase.type]);

  const remoteCall = !callSessionActive && activeCall.type === "ready" ? activeCall.call : null;
  const remoteCallHere =
    remoteCall !== null &&
    remoteCall.environmentId === environmentId &&
    remoteCall.threadId === currentContext.threadId;
  const shownCallContext =
    callSessionActive || remoteCall === null || remoteCallHere
      ? callPresentation.context
      : {
          ...currentContext,
          threadId: remoteCall.threadId,
          threadTitle: "Active Call thread",
          projectTitle: remoteCall.activeDevice?.label ?? "Another device",
        };
  const shownCallEnvironmentId = remoteCall?.environmentId ?? callPresentation.environmentId;
  const actionableError =
    callSessionHere &&
    (voice.state.phase.type === "error" || voice.state.phase.type === "unsupported");
  const headerStatus = callSessionActive
    ? realtimeVoiceStateLabel(voice.state)
    : remoteCall !== null
      ? `Active on ${remoteCall.activeDevice?.label ?? "another device"}`
      : actionableError
        ? realtimeVoiceStateLabel(voice.state)
        : "Ready";

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Call">
      <header className="flex min-h-14 items-center gap-3 border-border/60 border-b px-3">
        <span
          className={
            callSessionActive
              ? "flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary"
              : "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          }
          aria-hidden="true"
        >
          {callSessionHere && voice.state.muted ? (
            <MicOffIcon className="size-4" />
          ) : (
            <PhoneIcon className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Call</h2>
          <p
            className={
              actionableError
                ? "truncate text-xs text-destructive-foreground"
                : "truncate text-xs text-muted-foreground"
            }
            aria-live="polite"
          >
            {headerStatus}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Voice settings"
          render={<Link to="/settings/speech" />}
        >
          <Settings2Icon />
        </Button>
      </header>

      <VoiceCallSurface
        environmentId={environmentId}
        callEnvironmentId={shownCallEnvironmentId}
        callContext={shownCallContext}
        viewedContext={currentContext}
        setup={setup}
        sessionHere={callSessionHere}
        sessionActive={callSessionActive}
        otherSessionActive={sessionActive && !callSessionHere}
        callAvailable={callAvailable}
        remoteCall={remoteCall}
        presented={presented}
        {...(onMaterializeThreadForCall === undefined ? {} : { onMaterializeThreadForCall })}
      />
    </section>
  );
}
