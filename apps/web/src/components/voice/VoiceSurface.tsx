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
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  RotateCcwIcon,
  Settings2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { VoiceControlButton } from "./VoiceControlButton";
import { VoiceTargetStrip } from "./VoiceTargetStrip";
import { VoiceTranscript } from "./VoiceTranscript";

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
}

export interface VoiceSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly currentContext: VoiceSurfaceContext;
  readonly setup: VoiceSurfaceSetup | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The voice thread could not be read.";
}

export function VoiceSurface({ environmentId, currentContext, setup }: VoiceSurfaceProps) {
  const voice = useVoiceSession();
  const [lookup, setLookup] = useState<ControllerLookup>({ type: "loading" });
  const [history, setHistory] = useState<HistoryLookup>({ type: "idle", messages: [] });
  const [targetSync, setTargetSync] = useState<TargetSync>({ type: "idle" });
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const sessionHere = voice.state.environmentId === environmentId;
  const sessionActive = sessionHere && voice.state.phase.type !== "idle";

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

  const controllerThreadId = sessionHere
    ? (voice.state.controller?.threadId ??
      (lookup.type === "ready" ? lookup.controller?.controllerThreadId : null))
    : lookup.type === "ready"
      ? lookup.controller?.controllerThreadId
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
        {controllerThreadId ? startControl : null}
        {sessionActive ? (
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
            {voice.state.phase.type === "error" && voice.state.phase.recoverable ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Reconnect voice"
                onClick={() => void voice.reconnect()}
              >
                <RotateCcwIcon />
              </Button>
            ) : null}
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
    </section>
  );
}
