import { realtimeVoiceStateLabel } from "@shuv2code/client-runtime/state/realtime-voice";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceControllerHistoryMessage,
  VoiceControllerIdentity,
} from "@shuv2code/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRightIcon,
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  PhoneIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  Volume2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore, type VoiceSurfaceMode } from "../../rightPanelStore";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import {
  acquireVoiceMicrophoneStream,
  releaseVoiceMicrophoneStream,
} from "../../voice/voiceMicrophoneAccess";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { VoiceControlButton } from "./VoiceControlButton";
import { VoiceActionStatusStrip } from "./VoiceActionStatusStrip";
import { VoiceTargetStrip } from "./VoiceTargetStrip";
import { VoiceTranscript } from "./VoiceTranscript";
import { VoicePresence } from "./VoicePresence";
import { resolveVoiceCallPresentation, resolveVoicePresencePhase } from "./VoiceSurface.logic";
import { voicePhaseStyle } from "./voicePresenceTheme";

type ControllerLookup =
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly controller: VoiceControllerIdentity | null }
  | { readonly type: "error"; readonly message: string };

type HistoryLookup =
  | { readonly type: "idle"; readonly messages: ReadonlyArray<VoiceControllerHistoryMessage> }
  | { readonly type: "loading"; readonly messages: ReadonlyArray<VoiceControllerHistoryMessage> }
  | { readonly type: "ready"; readonly messages: ReadonlyArray<VoiceControllerHistoryMessage> }
  | {
      readonly type: "error";
      readonly message: string;
      readonly messages: ReadonlyArray<VoiceControllerHistoryMessage>;
    };

type TargetSync =
  | { readonly type: "idle" | "syncing" | "ready" }
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
  readonly presented?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The voice thread could not be read.";
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

function VoiceModeSwitch(props: {
  readonly mode: VoiceSurfaceMode;
  readonly onChange: (mode: VoiceSurfaceMode) => void;
}) {
  return (
    <div className="mx-3 mt-3 grid grid-cols-2 rounded-lg bg-secondary/70 p-0.5">
      {(["controller", "call"] as const).map((mode) => {
        return (
          <button
            key={mode}
            type="button"
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              props.mode === mode
                ? "bg-background text-foreground shadow-sm/5"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={props.mode === mode}
            onClick={() => props.onChange(mode)}
          >
            <span className="flex items-center justify-center gap-1.5">
              {mode === "controller" ? (
                <SlidersHorizontalIcon className="size-3.5" />
              ) : (
                <PhoneIcon className="size-3.5" />
              )}
              {mode === "controller" ? "Controller" : "Call"}
            </span>
            <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
              {mode === "controller" ? "All threads" : "This thread"}
            </span>
          </button>
        );
      })}
    </div>
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
  readonly presented: boolean;
  readonly onControllerMode: () => void;
}) {
  const voice = useVoiceSession();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const phase = resolveVoicePresencePhase(
    props.sessionHere,
    voice.state.phase,
    voice.state.muted,
    voice.mediaActivity,
  );
  const assistantText = latestTranscript(voice.state.transcript, "assistant");
  const userText = latestTranscript(voice.state.transcript, "user");
  const activityText = voice.state.controllerAction?.statusText ?? "Working in this thread…";
  const temporal =
    phase === "speaking"
      ? { label: "Voice · speaking", text: assistantText || "Preparing a response…" }
      : phase === "thinking"
        ? { label: "Working", text: activityText }
        : phase === "muted"
          ? { label: "Call paused", text: "Your microphone is muted." }
          : phase === "listening"
            ? { label: "You · live", text: userText || "Listening…" }
            : null;

  const startCall = async (context = props.viewedContext) => {
    const threadId = context.threadId;
    const setup = props.setup;
    if (threadId === null || setup === null || starting) return;
    setStarting(true);
    setStartError(null);
    let microphoneStream: MediaStream | undefined;
    try {
      if (voice.state.phase.type === "error" || voice.state.phase.type === "unsupported") {
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
          threadTitle: context.threadTitle,
        },
        hostProjectId: setup.hostProjectId,
        providerInstanceId: setup.providerInstanceId,
        modelSelection: setup.modelSelection,
        authorizedRuntimeCeiling: "approval-required",
        microphoneStream: preparedMicrophone,
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

  const returnToCallThread = () => {
    const threadId = props.callContext.threadId;
    if (threadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: props.callEnvironmentId, threadId },
    });
  };

  const moveCallToViewedThread = async () => {
    if (props.viewedContext.threadId === null || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await voice.stop();
      await startCall(props.viewedContext);
    } catch (error) {
      setStartError(errorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden"
      style={voicePhaseStyle(phase)}
    >
      <VoicePresence
        phase={phase}
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
              Call thread
            </p>
            <h2 className="truncate text-sm font-semibold">{props.callContext.threadTitle}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {props.callContext.projectTitle} · Durable work stays here
            </p>
          </div>
          <span className="mt-1 shrink-0 text-[11px] font-medium text-[var(--voice-accent)] transition-colors duration-700">
            Thread-owned
          </span>
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
            {props.viewedContext.threadId !== null && props.setup !== null ? (
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
              {props.otherSessionActive
                ? "Controller voice is active"
                : props.callAvailable
                  ? "Call this thread"
                  : "Start this thread to call it"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {props.otherSessionActive
                ? "End Controller voice before starting a thread-owned Call."
                : props.callAvailable
                  ? "Speak directly in this thread. Your voice turns stay with its context."
                  : "Call belongs to one ordinary thread. Drafts do not have thread context yet."}
            </p>
            {startError || (props.sessionHere && voice.state.phase.type === "error") ? (
              <p className="mt-3 text-xs text-destructive-foreground" role="alert">
                {startError ??
                  (voice.state.phase.type === "error" ? voice.state.phase.message : null)}
              </p>
            ) : null}
            {props.callAvailable && props.setup && !props.otherSessionActive ? (
              <Button
                className="mt-4"
                size="sm"
                disabled={starting}
                onClick={() => void startCall(props.viewedContext)}
              >
                {starting ? <LoaderCircleIcon className="animate-spin" /> : <PhoneIcon />}
                {starting ? "Starting…" : "Start call"}
              </Button>
            ) : (
              <Button className="mt-4" size="sm" onClick={props.onControllerMode}>
                <SlidersHorizontalIcon />
                Use Controller
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
          <div className="mx-auto flex w-full max-w-xs items-center justify-between px-6">
            <Button
              className="size-11 rounded-full border border-border/80 bg-background/42 text-muted-foreground shadow-none"
              variant="ghost"
              size="icon"
              aria-label="Speaker output"
            >
              <Volume2Icon />
            </Button>
            <Button
              className="size-16 rounded-full border border-foreground/45 bg-background/48 text-foreground shadow-none"
              variant="ghost"
              size="icon"
              onClick={() => voice.setMuted(!voice.state.muted)}
              aria-label={voice.state.muted ? "Unmute" : "Mute"}
            >
              {voice.state.muted ? (
                <MicOffIcon className="size-6" />
              ) : (
                <MicIcon className="size-6" />
              )}
            </Button>
            <Button
              className="size-11 rounded-full border border-border/80 bg-background/42 text-muted-foreground shadow-none hover:text-destructive"
              variant="ghost"
              size="icon"
              onClick={() => void voice.stop()}
              aria-label="End call"
            >
              <PhoneOffIcon />
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
  presented = true,
}: VoiceSurfaceProps) {
  const voice = useVoiceSession();
  const mode = useRightPanelStore(
    (state) => state.byEnvironmentId[environmentId]?.voiceMode ?? "controller",
  );
  const setMode = useRightPanelStore((state) => state.setVoiceMode);
  const [lookup, setLookup] = useState<ControllerLookup>({ type: "loading" });
  const [history, setHistory] = useState<HistoryLookup>({ type: "idle", messages: [] });
  const [targetSync, setTargetSync] = useState<TargetSync>({ type: "idle" });
  const [historyRefresh, setHistoryRefresh] = useState(0);
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
  const callAvailable = currentContext.threadId !== null;

  const loadController = useCallback(async () => {
    setLookup({ type: "loading" });
    try {
      const controller = await voice.getController(environmentId);
      setLookup({ type: "ready", controller });
    } catch (error) {
      setLookup({ type: "error", message: errorMessage(error) });
    }
  }, [environmentId, voice.getController]);

  useEffect(() => {
    void loadController();
  }, [loadController, voice.state.generation]);

  const sessionControllerThreadId =
    sessionHere &&
    voice.state.owner?.kind !== "thread-call" &&
    voice.state.owner?.kind !== "transcription-test"
      ? voice.state.controller?.threadId
      : null;
  const controllerThreadId =
    mode === "controller"
      ? (sessionControllerThreadId ??
        (lookup.type === "ready" ? lookup.controller?.controllerThreadId : null))
      : null;

  useEffect(() => {
    let cancelled = false;
    if (!controllerThreadId) {
      setHistory({ type: "idle", messages: [] });
      return () => {
        cancelled = true;
      };
    }
    setHistory((current) => ({ type: "loading", messages: current.messages }));
    void voice
      .getControllerHistory(environmentId, controllerThreadId)
      .then((messages) => {
        if (!cancelled) setHistory({ type: "ready", messages });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHistory((current) => ({
            type: "error",
            message: errorMessage(error),
            messages: current.messages,
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    controllerThreadId,
    environmentId,
    historyRefresh,
    sessionActive,
    voice.getControllerHistory,
  ]);

  useEffect(() => {
    let cancelled = false;
    const targetThreadId = currentContext.threadId;
    if (!controllerThreadId || targetThreadId === null) {
      setTargetSync({ type: "idle" });
      return () => {
        cancelled = true;
      };
    }
    setTargetSync({ type: "syncing" });
    void voice
      .setControllerTarget(environmentId, controllerThreadId, targetThreadId)
      .then(() => {
        if (!cancelled) setTargetSync({ type: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setTargetSync({ type: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [controllerThreadId, currentContext.threadId, environmentId, voice.setControllerTarget]);

  const label = sessionHere ? realtimeVoiceStateLabel(voice.state) : "Voice is off";
  const actionableError =
    sessionHere && (voice.state.phase.type === "error" || voice.state.phase.type === "unsupported");
  const startControl =
    !sessionActive && setup ? (
      <VoiceControlButton
        surface
        environmentId={environmentId}
        hostProjectId={setup.hostProjectId}
        {...(currentContext.threadId === null ? {} : { targetThreadId: currentContext.threadId })}
        providerInstanceId={setup.providerInstanceId}
        modelSelection={setup.modelSelection}
        realtimeEnabled={setup.realtimeEnabled}
        threadReadEnabled={setup.threadReadEnabled}
        threadControlEnabled={setup.threadControlEnabled}
      />
    ) : null;

  // An active thread-owned Call remains the primary Voice surface across
  // navigation, even when the newly viewed environment has another saved tab.
  const shownMode = callSessionActive ? "call" : mode;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Voice">
      <header className="flex min-h-14 items-center gap-3 border-border/60 border-b px-3">
        <span
          className={
            sessionActive
              ? "flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary"
              : "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          }
          aria-hidden="true"
        >
          {sessionHere && voice.state.muted ? (
            <MicOffIcon className="size-4" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Voice</h2>
          <p
            className={
              actionableError
                ? "truncate text-xs text-destructive-foreground"
                : "truncate text-xs text-muted-foreground"
            }
            aria-live="polite"
          >
            {label}
          </p>
        </div>
        {shownMode === "controller" && controllerThreadId ? startControl : null}
        {shownMode === "controller" && sessionActive ? (
          <>
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
            <Button
              size="icon-sm"
              variant="destructive-outline"
              aria-label="End voice"
              onClick={() => void voice.stop()}
            >
              <PhoneOffIcon />
            </Button>
          </>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Voice settings"
          render={<Link to="/settings/speech" />}
        >
          <Settings2Icon />
        </Button>
      </header>

      <VoiceModeSwitch mode={shownMode} onChange={(nextMode) => setMode(environmentId, nextMode)} />

      {shownMode === "call" ? (
        <VoiceCallSurface
          environmentId={environmentId}
          callEnvironmentId={callPresentation.environmentId}
          callContext={callPresentation.context}
          viewedContext={currentContext}
          setup={setup}
          sessionHere={callSessionHere}
          sessionActive={callSessionActive}
          otherSessionActive={sessionActive && !callSessionHere}
          callAvailable={callAvailable}
          presented={presented}
          onControllerMode={() => setMode(environmentId, "controller")}
        />
      ) : (
        <>
          <div className="flex min-h-12 items-center gap-3 border-border/60 border-b bg-muted/20 px-3 py-2">
            <MessageSquareTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{currentContext.threadTitle}</p>
              <p className="truncate text-xs text-muted-foreground">
                {currentContext.threadId === null
                  ? "Start this thread to make its context available"
                  : `${currentContext.projectTitle} · Current thread`}
              </p>
            </div>
            <span
              className={
                targetSync.type === "error"
                  ? "flex shrink-0 items-center gap-1.5 text-xs text-destructive-foreground"
                  : "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              }
              title={targetSync.type === "error" ? targetSync.message : undefined}
              aria-label={
                currentContext.threadId === null
                  ? "Draft context is not available to voice"
                  : !controllerThreadId
                    ? "Current thread will be available when voice starts"
                    : targetSync.type === "ready"
                      ? "Current thread available to voice"
                      : targetSync.type === "error"
                        ? `Current thread unavailable to voice: ${targetSync.message}`
                        : "Updating current voice context"
              }
            >
              {currentContext.threadId === null ? (
                "Draft"
              ) : !controllerThreadId ? (
                "On start"
              ) : targetSync.type === "ready" ? (
                <>
                  <CheckIcon className="size-3.5" /> Available
                </>
              ) : targetSync.type === "error" ? (
                <>
                  <CircleAlertIcon className="size-3.5" /> Unavailable
                </>
              ) : (
                <>
                  <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                  Updating
                </>
              )}
            </span>
          </div>

          {sessionHere && voice.state.controllerAction ? (
            <VoiceActionStatusStrip action={voice.state.controllerAction} />
          ) : null}

          {lookup.type === "loading" && !controllerThreadId ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <p className="text-sm text-muted-foreground">Loading voice…</p>
            </div>
          ) : lookup.type === "error" && !controllerThreadId ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="max-w-sm text-center">
                <p className="text-sm font-medium">Voice is unavailable</p>
                <p className="mt-1 text-sm text-muted-foreground">{lookup.message}</p>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="outline"
                  onClick={() => void loadController()}
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : !controllerThreadId ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="max-w-sm text-center">
                <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <MicIcon className="size-5" />
                </span>
                <h3 className="mt-4 text-sm font-semibold">Start a voice conversation</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  It stays available as you move between threads.
                </p>
                <div className="mt-4 flex justify-center">
                  {startControl ?? (
                    <Button size="sm" variant="outline" render={<Link to="/settings/speech" />}>
                      Voice settings
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5">
                {history.type === "error" ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                    <p className="font-medium">Conversation unavailable</p>
                    <p className="mt-1 text-muted-foreground">{history.message}</p>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      onClick={() => setHistoryRefresh((current) => current + 1)}
                    >
                      Try again
                    </Button>
                  </div>
                ) : null}
                {history.type === "loading" && history.messages.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Loading conversation…
                  </p>
                ) : history.messages.length === 0 && history.type !== "error" ? (
                  <div className="py-10 text-center">
                    <p className="text-sm font-medium">Ready when you are</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Start voice and speak from this panel.
                    </p>
                  </div>
                ) : (
                  history.messages.map((message) => (
                    <article
                      key={message.id}
                      className={
                        message.role === "user"
                          ? "ml-auto max-w-[88%] rounded-xl bg-primary px-3 py-2 text-primary-foreground"
                          : "max-w-[92%]"
                      }
                    >
                      <p className="mb-1 text-[11px] font-medium opacity-70">
                        {message.role === "user" ? "You" : "Voice"}
                      </p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
                    </article>
                  ))
                )}
                {sessionHere && voice.state.transcript.length > 0 ? (
                  <section className="border-border/60 border-t pt-3" aria-label="Live transcript">
                    <p className="px-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Live
                    </p>
                    <VoiceTranscript items={voice.state.transcript} expanded />
                  </section>
                ) : null}
              </div>
            </ScrollArea>
          )}
          {sessionHere && voice.state.activeTarget ? (
            <VoiceTargetStrip target={voice.state.activeTarget} />
          ) : null}
        </>
      )}
    </section>
  );
}
