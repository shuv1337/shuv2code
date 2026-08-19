import {
  ArchiveIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  HistoryIcon,
  Link2Icon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { realtimeVoiceStateLabel } from "@shuv2code/client-runtime/state/realtime-voice";
import { createModelSelection } from "@shuv2code/shared/model";

import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { usePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironment } from "~/state/environments";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
} from "~/state/entities";
import { useVoiceSession } from "~/voice/VoiceSessionProvider";
import {
  acquireVoiceMicrophoneStream,
  releaseVoiceMicrophoneStream,
} from "~/voice/voiceMicrophoneAccess";

import { VoicePresence } from "./VoicePresence";
import { useVoiceActivityLab, type VoiceLabSignalMode } from "./useVoiceActivityLab";
import { type VoicePresencePhase, voicePhaseStyle } from "./voicePresenceTheme";

type VoiceMode = "controller" | "call";
type CallPhase = VoicePresencePhase;

interface MockMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly detail?: string;
}

interface ControllerConversation {
  readonly id: string;
  readonly title: string;
  readonly updatedLabel: string;
  readonly archived: boolean;
  readonly messages: ReadonlyArray<MockMessage>;
}

const THREAD = {
  title: "Provider recovery",
  project: "shuv2code",
} as const;

const INITIAL_CONVERSATIONS: ReadonlyArray<ControllerConversation> = [
  {
    id: "morning-check-in",
    title: "Morning check-in",
    updatedLabel: "12 min ago",
    archived: false,
    messages: [
      {
        id: "morning-1",
        role: "user",
        text: "What is still moving across shuv2code?",
      },
      {
        id: "morning-2",
        role: "assistant",
        text: "Across your threads, the Voice surface is ready for UX work. Desktop startup is fixed, and provider recovery has one follow-up to verify.",
      },
      {
        id: "morning-3",
        role: "user",
        text: "Take me to the provider recovery thread.",
      },
      {
        id: "morning-4",
        role: "assistant",
        text: "Opened Provider recovery.",
        detail: "Navigated to thread",
      },
    ],
  },
  {
    id: "release-follow-up",
    title: "Release follow-up",
    updatedLabel: "Yesterday",
    archived: false,
    messages: [
      {
        id: "release-1",
        role: "user",
        text: "Which release checks still need attention?",
      },
      {
        id: "release-2",
        role: "assistant",
        text: "Packaging is repaired. The remaining work is a focused voice flow check in the browser.",
      },
    ],
  },
  {
    id: "routing-cleanup",
    title: "Routing cleanup",
    updatedLabel: "Aug 8",
    archived: true,
    messages: [
      {
        id: "routing-1",
        role: "assistant",
        text: "The old routing notes are captured here if you need them again.",
      },
    ],
  },
];

function Message({ message }: { readonly message: MockMessage }) {
  const isUser = message.role === "user";

  return (
    <article
      className={
        isUser
          ? "ml-auto max-w-[88%] rounded-xl bg-primary px-3 py-2 text-primary-foreground"
          : "max-w-[92%]"
      }
    >
      <p className="mb-1 text-[11px] font-medium opacity-70">{isUser ? "You" : "Voice"}</p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
      {message.detail ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 text-success" />
          {message.detail}
        </div>
      ) : null}
    </article>
  );
}

const CALL_PHASE_TIMING: Readonly<
  Partial<Record<CallPhase, { readonly next: CallPhase; readonly delay: number }>>
> = {
  listening: { next: "thinking", delay: 4_800 },
  thinking: { next: "speaking", delay: 3_200 },
  speaking: { next: "listening", delay: 6_000 },
};

function CallTemporalFeed(props: {
  readonly phase: CallPhase;
  readonly signalMode: VoiceLabSignalMode;
  readonly userTranscript: string;
  readonly assistantTranscript: string;
  readonly actionStatus: string;
}) {
  const { actionStatus, assistantTranscript, phase, signalMode, userTranscript } = props;
  if (phase === "idle") return null;

  const content =
    phase === "listening"
      ? {
          label: "You · live",
          text:
            signalMode === "transcription" || signalMode === "realtime"
              ? userTranscript || "Say something…"
              : "…and check whether the provider session recovered after the reconnect.",
          tone: "text-foreground",
        }
      : phase === "thinking"
        ? {
            label: "Searching",
            text: actionStatus || "Working in the thread…",
            tone: "text-muted-foreground",
          }
        : phase === "speaking"
          ? {
              label: "Voice · speaking",
              text:
                signalMode === "realtime"
                  ? assistantTranscript || "Preparing a response…"
                  : "I found the reconnect. The same provider session resumed without duplicating any turns.",
              tone: "text-foreground",
            }
          : {
              label: "Call paused",
              text: "Your microphone is muted.",
              tone: "text-muted-foreground",
            };

  return (
    <div className="mx-auto min-h-24 w-full max-w-sm px-3 text-center" aria-live="polite">
      <p className="text-[11px] font-medium text-[var(--voice-accent)]">{content.label}</p>
      <p className={cn("mt-1 text-sm leading-relaxed", content.tone)}>{content.text}</p>
      {phase === "thinking" ? (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-[var(--voice-accent)] motion-reduce:animate-none" />
          {actionStatus || "Reading the thread’s latest activity"}
        </div>
      ) : phase === "speaking" ? (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CheckIcon className="size-3.5 text-success" />
          Checked provider session continuity
        </div>
      ) : null}
    </div>
  );
}

function CallExperience(props: {
  readonly phase: CallPhase;
  readonly onPhaseChange: (phase: CallPhase) => void;
  readonly onSessionKindChange: (kind: "call" | "transcription" | null) => void;
  readonly toolsOpen: boolean;
}) {
  const [speakerOn, setSpeakerOn] = useState(true);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const signal = useVoiceActivityLab(props.phase, props.onPhaseChange);
  const voice = useVoiceSession();
  const primaryEnvironment = usePrimaryEnvironment();
  const projects = useProjects();
  const environmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const serverConfigs = useServerConfigs();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const settings = usePrimarySettings();
  const [realtimeStarting, setRealtimeStarting] = useState(false);
  const [transcriptionStarting, setTranscriptionStarting] = useState(false);
  const serverConfig = environmentId ? serverConfigs.get(environmentId) : undefined;
  const environmentProjects = environmentId
    ? projects.filter((candidate) => candidate.environmentId === environmentId)
    : [];
  const project = environmentProjects[0];
  const provider = serverConfig?.providers.find(
    (candidate) =>
      candidate.driver === "codex" &&
      candidate.enabled &&
      candidate.installed &&
      candidate.availability !== "unavailable",
  );
  const configuredProjectModel = project?.defaultModelSelection ?? null;
  const projectModelSelection =
    configuredProjectModel?.instanceId === provider?.instanceId ? configuredProjectModel : null;
  const defaultModel = provider?.models.find((model) => model.isDefault) ?? provider?.models[0];
  const modelSelection =
    projectModelSelection ??
    (provider && defaultModel
      ? createModelSelection(provider.instanceId, defaultModel.slug)
      : null);

  const realtimeUnavailableReason = !environmentId
    ? "Environment is still connecting"
    : primaryEnvironment?.connection.phase !== "connected"
      ? primaryEnvironment?.connection.phase === "reconnecting"
        ? "Environment connection lost. Reconnecting…"
        : primaryEnvironment?.connection.phase === "error"
          ? (primaryEnvironment.connection.error ?? "Environment connection failed")
          : primaryEnvironment?.connection.phase === "offline"
            ? "Environment is offline"
            : "Environment is still connecting"
      : !environmentShellsBootstrapped
        ? "Loading voice environment…"
        : !settings.enableRealtimeVoice
          ? "Realtime voice is disabled in server settings"
          : !settings.enableVoiceThreadRead
            ? "Voice thread access is disabled in server settings"
            : null;
  const realtimeReady = realtimeUnavailableReason === null && !realtimeStarting;
  const realtimeHere = environmentId !== null && voice.state.environmentId === environmentId;
  const latestRealtimeTranscript = (speaker: "user" | "assistant") =>
    realtimeHere
      ? ([...voice.state.transcript]
          .toReversed()
          .find((item) => item.speaker === speaker && item.text.trim().length > 0)?.text ?? "")
      : "";
  const realtimeUserTranscript = latestRealtimeTranscript("user");
  const realtimeAssistantTranscript = latestRealtimeTranscript("assistant");
  const realtimeActive = realtimeHere && voice.state.phase.type !== "idle";
  const localTranscriptionActive = signal.mode === "transcription";
  const realtimeStatus = realtimeActive
    ? realtimeVoiceStateLabel(voice.state)
    : realtimeStarting
      ? "Starting your Voice controller…"
      : (realtimeUnavailableReason ?? "Uses your existing Voice controller");
  const active = props.phase !== "idle";
  const muted = props.phase === "muted";
  const speaking = props.phase === "speaking";
  const thinking = props.phase === "thinking";

  useEffect(() => {
    if (signal.mode !== "showcase") return;
    const timing = CALL_PHASE_TIMING[props.phase];
    if (!timing) return;
    const timeout = window.setTimeout(() => props.onPhaseChange(timing.next), timing.delay);
    return () => window.clearTimeout(timeout);
  }, [props.onPhaseChange, props.phase, signal.mode]);

  useEffect(() => {
    if (signal.mode !== "realtime" || !realtimeActive) return;
    const nextPhase =
      voice.state.phase.type === "connected"
        ? voice.state.phase.activity === "assistant-speaking"
          ? "speaking"
          : voice.state.phase.activity === "thinking"
            ? "thinking"
            : "listening"
        : "thinking";
    props.onPhaseChange(nextPhase);
  }, [props.onPhaseChange, realtimeActive, signal.mode, voice.state.phase]);

  const startRealtime = async () => {
    if (!environmentId || !environmentShellsBootstrapped || realtimeUnavailableReason) {
      return;
    }
    let microphoneStream: MediaStream | undefined;
    try {
      setRealtimeError(null);
      props.onSessionKindChange("call");
      setRealtimeStarting(true);
      const existing = await voice.getController(environmentId);
      if (!existing && (!project || !provider || !modelSelection)) {
        throw new Error("Set up Voice from a thread before testing it here.");
      }
      microphoneStream = await acquireVoiceMicrophoneStream();
      const preparedMicrophone = microphoneStream;
      microphoneStream = undefined;
      await voice.start(
        existing
          ? {
              environmentId,
              hostProjectId: existing.hostProjectId,
              providerInstanceId: existing.providerInstanceId,
              authorizedRuntimeCeiling: existing.authorizedRuntimeCeiling,
              microphoneStream: preparedMicrophone,
              onMicrophoneStream: signal.useRealtime,
              onRemoteAudioStream: signal.attachRealtimeOutput,
            }
          : {
              environmentId,
              hostProjectId: project!.id,
              providerInstanceId: provider!.instanceId,
              modelSelection: modelSelection!,
              authorizedRuntimeCeiling: "approval-required",
              microphoneStream: preparedMicrophone,
              onMicrophoneStream: signal.useRealtime,
              onRemoteAudioStream: signal.attachRealtimeOutput,
            },
      );
    } catch (error) {
      signal.useShowcase();
      props.onSessionKindChange(null);
      setRealtimeError(error instanceof Error ? error.message : "Realtime voice could not start.");
    } finally {
      setRealtimeStarting(false);
      releaseVoiceMicrophoneStream(microphoneStream);
    }
  };

  useEffect(() => {
    if (signal.mode !== "realtime" || realtimeAssistantTranscript.length === 0) return;
    props.onPhaseChange("speaking");
  }, [props.onPhaseChange, realtimeAssistantTranscript, signal.mode]);

  const startTranscription = async () => {
    if (!environmentId || !environmentShellsBootstrapped || realtimeUnavailableReason) return;
    let microphoneStream: MediaStream | undefined;
    let providerStarted = false;
    try {
      setRealtimeError(null);
      if (realtimeActive) await voice.stop();
      setTranscriptionStarting(true);
      const existing = await voice.getController(environmentId);
      if (!existing && (!project || !provider || !modelSelection)) {
        throw new Error("Set up Voice from a thread before testing transcription here.");
      }
      microphoneStream = await acquireVoiceMicrophoneStream();
      const preparedMicrophone = microphoneStream;
      microphoneStream = undefined;
      await voice.start(
        existing
          ? {
              environmentId,
              hostProjectId: existing.hostProjectId,
              providerInstanceId: existing.providerInstanceId,
              authorizedRuntimeCeiling: existing.authorizedRuntimeCeiling,
              purpose: "transcription",
              microphoneStream: preparedMicrophone,
            }
          : {
              environmentId,
              hostProjectId: project!.id,
              providerInstanceId: provider!.instanceId,
              modelSelection: modelSelection!,
              authorizedRuntimeCeiling: "approval-required",
              purpose: "transcription",
              microphoneStream: preparedMicrophone,
            },
      );
      providerStarted = true;
      await signal.useProviderTranscription(preparedMicrophone);
      props.onSessionKindChange("transcription");
    } catch (error) {
      if (providerStarted) await voice.stop().catch(() => undefined);
      signal.useShowcase();
      props.onSessionKindChange(null);
      setRealtimeError(error instanceof Error ? error.message : "Transcription could not start.");
    } finally {
      setTranscriptionStarting(false);
      releaseVoiceMicrophoneStream(microphoneStream);
    }
  };

  return (
    <section
      className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-3 pt-5 text-center"
      aria-label={`Call ${THREAD.title}`}
    >
      <VoicePresence phase={props.phase} activityLevel={signal.activityLevel} />

      {props.toolsOpen ? (
        <CallLabTools
          mode={signal.mode}
          error={realtimeError ?? signal.error}
          microphoneTranscript={realtimeUserTranscript}
          realtimeReady={realtimeReady}
          realtimeStarting={realtimeStarting}
          transcriptionStarting={transcriptionStarting}
          localTranscriptionActive={localTranscriptionActive}
          realtimeStatus={realtimeStatus}
          onShowcase={() => {
            setRealtimeError(null);
            signal.useShowcase();
          }}
          onMicrophone={() => {
            setRealtimeError(null);
            void (localTranscriptionActive
              ? voice.stop().finally(() => {
                  signal.useShowcase();
                  props.onSessionKindChange(null);
                  props.onPhaseChange("idle");
                })
              : startTranscription());
          }}
          onPlayReply={() => {
            setRealtimeError(null);
            void signal.playReply();
          }}
          onRealtime={() =>
            void (realtimeActive
              ? voice.stop().finally(() => {
                  signal.useShowcase();
                  props.onSessionKindChange(null);
                  props.onPhaseChange("idle");
                })
              : startRealtime())
          }
        />
      ) : null}

      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-end pb-[clamp(4rem,10vh,7rem)]">
        {!active ? (
          <Button
            className="mt-2 min-w-40 border-[var(--voice-accent)] bg-[var(--voice-accent)] text-[var(--voice-shadow)] shadow-none hover:bg-[var(--voice-highlight)]"
            size="lg"
            onClick={() => {
              props.onSessionKindChange("call");
              props.onPhaseChange("listening");
            }}
          >
            <PhoneIcon />
            Start call
          </Button>
        ) : (
          <CallTemporalFeed
            phase={props.phase}
            signalMode={signal.mode}
            userTranscript={
              signal.mode === "realtime" || signal.mode === "transcription"
                ? realtimeUserTranscript
                : ""
            }
            assistantTranscript={realtimeAssistantTranscript}
            actionStatus={realtimeHere ? (voice.state.controllerAction?.statusText ?? "") : ""}
          />
        )}
      </div>

      {active ? (
        <div className="shrink-0 pt-4">
          <div className="mb-2 flex items-center justify-center gap-2 text-xs">
            <span className="size-2 rounded-full bg-[var(--voice-accent)] transition-colors duration-700" />
            <span className="font-medium">
              {muted ? "Muted" : thinking ? "Searching" : speaking ? "Speaking" : "Listening"}
            </span>
            <span className="text-muted-foreground">00:18</span>
          </div>
          <div className="mx-auto flex w-full max-w-xs items-center justify-between px-5">
            <Button
              className="size-11 rounded-full border border-border/80 bg-background/42 text-muted-foreground shadow-none hover:bg-background/72 hover:text-foreground"
              variant="ghost"
              size="icon"
              onClick={() => setSpeakerOn((current) => !current)}
              aria-label={speakerOn ? "Turn speaker off" : "Turn speaker on"}
            >
              <Volume2Icon />
            </Button>
            <Button
              className={cn(
                "size-16 rounded-full border bg-background/48 shadow-none transition-[color,border-color,background-color] duration-700",
                muted
                  ? "border-[var(--voice-accent)] text-[var(--voice-accent)]"
                  : "border-foreground/45 text-foreground hover:bg-background/76",
              )}
              variant="ghost"
              size="icon"
              onClick={() => props.onPhaseChange(muted ? "listening" : "muted")}
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted ? <MicOffIcon className="size-6" /> : <MicIcon className="size-6" />}
            </Button>
            <Button
              className="size-11 rounded-full border border-border/80 bg-background/42 text-muted-foreground shadow-none hover:border-destructive/45 hover:bg-background/72 hover:text-destructive"
              variant="ghost"
              size="icon"
              onClick={() => {
                if (realtimeActive) void voice.stop();
                signal.useShowcase();
                props.onSessionKindChange(null);
                props.onPhaseChange("idle");
              }}
              aria-label="End call"
            >
              <PhoneOffIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CallLabTools(props: {
  readonly mode: VoiceLabSignalMode;
  readonly error: string | null;
  readonly microphoneTranscript: string;
  readonly realtimeReady: boolean;
  readonly realtimeStarting: boolean;
  readonly transcriptionStarting: boolean;
  readonly localTranscriptionActive: boolean;
  readonly realtimeStatus: string | null;
  readonly onShowcase: () => void;
  readonly onMicrophone: () => void;
  readonly onPlayReply: () => void;
  readonly onRealtime: () => void;
}) {
  return (
    <aside className="absolute right-3 top-3 z-20 w-64 rounded-xl border border-white/10 bg-background/92 p-3 text-left shadow-xl backdrop-blur-md">
      <p className="text-xs font-medium">Voice test</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
        Each test is independent. Nothing else starts with it.
      </p>
      <Button
        className="mt-3 w-full justify-center"
        variant={props.mode === "transcription" ? "secondary" : "outline"}
        size="sm"
        disabled={
          props.transcriptionStarting ||
          props.realtimeStarting ||
          (!props.realtimeReady && props.mode !== "transcription")
        }
        onClick={props.onMicrophone}
        title={props.realtimeReady ? undefined : (props.realtimeStatus ?? undefined)}
      >
        <MicIcon />
        {props.transcriptionStarting
          ? "Connecting transcription…"
          : props.mode === "transcription"
            ? "Stop transcription"
            : "Test transcription"}
      </Button>
      <Button
        className="mt-2 w-full justify-center"
        variant={props.mode === "playback" ? "secondary" : "outline"}
        size="sm"
        disabled={
          props.localTranscriptionActive ||
          props.mode === "realtime" ||
          props.transcriptionStarting ||
          props.realtimeStarting
        }
        onClick={props.onPlayReply}
      >
        <PlayIcon />
        Play agent reply
      </Button>
      <Button
        className="mt-2 w-full justify-center"
        variant={props.mode === "realtime" ? "secondary" : "outline"}
        size="sm"
        disabled={
          props.localTranscriptionActive ||
          props.transcriptionStarting ||
          props.realtimeStarting ||
          (!props.realtimeReady && props.mode !== "realtime")
        }
        onClick={props.onRealtime}
        title={props.realtimeReady ? undefined : (props.realtimeStatus ?? undefined)}
      >
        <MicIcon />
        {props.realtimeStarting
          ? "Preparing real voice…"
          : props.mode === "realtime"
            ? "Stop real voice"
            : "Test live call"}
      </Button>
      {props.realtimeStatus && (!props.realtimeReady || props.mode === "realtime") ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{props.realtimeStatus}</p>
      ) : null}
      {props.mode === "playback" ? (
        <p className="mt-2 text-[11px] text-[var(--voice-accent)]">Playing sample response</p>
      ) : null}
      {props.mode === "transcription" && props.microphoneTranscript ? (
        <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
          “{props.microphoneTranscript}”
        </p>
      ) : null}
      {props.mode === "transcription" && !props.microphoneTranscript && !props.error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Listening for your words. This test never calls or plays the agent.
        </p>
      ) : null}
      {props.error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-destructive">{props.error}</p>
      ) : null}
    </aside>
  );
}

function ModeSwitch(props: {
  readonly mode: VoiceMode;
  readonly onChange: (mode: VoiceMode) => void;
}) {
  return (
    <div className="mx-3 mt-3 grid grid-cols-2 rounded-lg bg-secondary/70 p-0.5">
      {(["controller", "call"] as const).map((mode) => (
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
      ))}
    </div>
  );
}

function ConversationHistory(props: {
  readonly conversations: ReadonlyArray<ControllerConversation>;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
  readonly onClose: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const visible = props.conversations.filter(
    (conversation) => conversation.archived === showArchived,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex items-center justify-between px-4 py-3">
        <div>
          <h1 className="text-sm font-semibold">Controller conversations</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Resume or archive previous controller sessions
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label="Close history">
          <XIcon />
        </Button>
      </header>

      <div className="flex items-center gap-1 px-3 pb-3">
        <button
          type="button"
          className={cn(
            "rounded-md px-2.5 py-1.5 text-xs font-medium",
            !showArchived ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
          onClick={() => setShowArchived(false)}
        >
          Recent
        </button>
        <button
          type="button"
          className={cn(
            "rounded-md px-2.5 py-1.5 text-xs font-medium",
            showArchived ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
          onClick={() => setShowArchived(true)}
        >
          Archived
        </button>
        <Button className="ml-auto" variant="ghost" size="xs" onClick={props.onNew}>
          <PlusIcon />
          New
        </Button>
      </div>

      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {visible.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={cn(
                "w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/60",
                props.selectedId === conversation.id && "bg-accent",
              )}
              onClick={() => props.onSelect(conversation.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="truncate text-sm font-medium">{conversation.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {conversation.updatedLabel}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {conversation.messages.at(-1)?.text ?? "No messages yet"}
              </p>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export function VoiceSurfaceLab() {
  const primaryEnvironment = usePrimaryEnvironment();
  const [mode, setMode] = useState<VoiceMode>("controller");
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [callToolsOpen, setCallToolsOpen] = useState(false);
  const [activeSessionKind, setActiveSessionKind] = useState<"call" | "transcription" | null>(null);
  const [draft, setDraft] = useState("");
  const [activeConversationId, setActiveConversationId] = useState(INITIAL_CONVERSATIONS[0]!.id);
  const [conversations, setConversations] = useState(INITIAL_CONVERSATIONS);
  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ??
    conversations[0]!;
  const callActive = phase !== "idle";
  const idleStatus =
    primaryEnvironment?.connection.phase === "connected"
      ? "Ready"
      : primaryEnvironment?.connection.phase === "reconnecting"
        ? "Reconnecting…"
        : primaryEnvironment?.connection.phase === "error"
          ? "Connection failed"
          : primaryEnvironment?.connection.phase === "offline"
            ? "Offline"
            : "Connecting…";

  const changeMode = (nextMode: VoiceMode) => {
    setMode(nextMode);
    setPhase("idle");
    setHistoryOpen(false);
    setCallToolsOpen(false);
    setActiveSessionKind(null);
  };

  const newConversation = () => {
    const id = `controller-${Date.now()}`;
    setConversations((current) => [
      {
        id,
        title: "New conversation",
        updatedLabel: "Now",
        archived: false,
        messages: [],
      },
      ...current,
    ]);
    setActiveConversationId(id);
    setHistoryOpen(false);
    setMode("controller");
    setPhase("idle");
  };

  const setConversationArchived = (archived: boolean) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === activeConversationId ? { ...conversation, archived } : conversation,
      ),
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    const timestamp = Date.now();
    const userMessage: MockMessage = { id: `user-${timestamp}`, role: "user", text };
    const assistantMessage: MockMessage = {
      id: `assistant-${timestamp}`,
      role: "assistant",
      text: "I’ll handle that across your shuv2code threads and keep this controller conversation here.",
    };

    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === activeConversationId
          ? {
              ...conversation,
              title:
                conversation.messages.length === 0
                  ? text.length > 36
                    ? `${text.slice(0, 36)}…`
                    : text
                  : conversation.title,
              updatedLabel: "Now",
              messages: [...conversation.messages, userMessage, assistantMessage],
            }
          : conversation,
      ),
    );
    setDraft("");
  };

  if (historyOpen && mode === "controller") {
    return (
      <main className="flex h-dvh min-h-0 w-full bg-background text-foreground">
        <ConversationHistory
          conversations={conversations}
          selectedId={activeConversationId}
          onSelect={(id) => {
            setActiveConversationId(id);
            setHistoryOpen(false);
          }}
          onNew={newConversation}
          onClose={() => setHistoryOpen(false)}
        />
      </main>
    );
  }

  return (
    <main
      className="flex h-dvh min-h-0 w-full flex-col bg-background text-foreground"
      style={mode === "call" ? voicePhaseStyle(phase) : undefined}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <MicIcon className="size-4" />
        <h1 className="text-sm font-semibold">Voice</h1>
        <span className="text-xs text-muted-foreground">
          {callActive
            ? phase === "muted"
              ? "Muted"
              : mode === "controller"
                ? "Controller active"
                : activeSessionKind === "transcription"
                  ? "Transcribing"
                  : "In call"
            : idleStatus}
        </span>
        {mode === "call" ? (
          <Button
            className={cn("ml-auto", callToolsOpen && "bg-accent")}
            variant="ghost"
            size="sm"
            aria-expanded={callToolsOpen}
            onClick={() => setCallToolsOpen((open) => !open)}
          >
            <SlidersHorizontalIcon />
            Test
          </Button>
        ) : (
          <Button className="ml-auto" variant="ghost" size="icon-sm" aria-label="Voice settings">
            <Settings2Icon />
          </Button>
        )}
      </header>

      <ModeSwitch mode={mode} onChange={changeMode} />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pb-3 pt-4">
          {mode === "controller" ? (
            <>
              <div className="mb-4 flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                  <SlidersHorizontalIcon className="size-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Voice controller</h2>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Create, inspect, and manage threads across shuv2code.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setHistoryOpen(true)}
                >
                  <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-semibold">{activeConversation.title}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={newConversation}
                  aria-label="New controller conversation"
                >
                  <PlusIcon />
                </Button>
                {activeConversation.archived ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setConversationArchived(false)}
                    aria-label="Restore conversation"
                  >
                    <RotateCcwIcon />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setConversationArchived(true)}
                    aria-label="Archive conversation"
                  >
                    <ArchiveIcon />
                  </Button>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/70 bg-card/55 px-3 py-2">
                <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-muted-foreground">Current thread reference</p>
                  <p className="truncate text-xs font-medium">{THREAD.title}</p>
                </div>
                <span className="text-[11px] text-muted-foreground">Available if needed</span>
              </div>
            </>
          ) : (
            <div className="flex items-start gap-3 pb-1">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--voice-accent)_12%,transparent)] text-[var(--voice-accent)] transition-colors duration-700">
                <PhoneIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">Call {THREAD.title}</h2>
                  {callActive ? (
                    <Badge variant="secondary">
                      {activeSessionKind === "transcription" ? "Transcribing" : "Live"}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {THREAD.project} · Voice turns stay in this thread
                </p>
              </div>
              <span className="mt-1 shrink-0 text-[11px] font-medium text-[var(--voice-accent)] transition-colors duration-700">
                Thread-owned
              </span>
            </div>
          )}
        </div>

        <Separator />
        {mode === "call" ? (
          <CallExperience
            phase={phase}
            onPhaseChange={setPhase}
            onSessionKindChange={setActiveSessionKind}
            toolsOpen={callToolsOpen}
          />
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex min-h-full flex-col gap-5 px-4 py-5">
                {activeConversation.messages.length > 0 ? (
                  activeConversation.messages.map((message) => (
                    <Message key={message.id} message={message} />
                  ))
                ) : (
                  <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
                    Start voice or type below.
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="shrink-0 border-t border-border bg-background p-3">
              {callActive ? (
                <div className="mb-3 flex items-center justify-between px-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="size-2 rounded-full bg-primary" />
                    <span className="font-medium">
                      {phase === "muted" ? "Muted" : "Controller listening"}
                    </span>
                    <span className="text-muted-foreground">00:18</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant={phase === "muted" ? "secondary" : "ghost"}
                      size="icon-sm"
                      onClick={() => setPhase(phase === "muted" ? "listening" : "muted")}
                      aria-label={phase === "muted" ? "Unmute" : "Mute"}
                    >
                      {phase === "muted" ? <MicOffIcon /> : <MicIcon />}
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon-sm"
                      onClick={() => setPhase("idle")}
                      aria-label="Stop voice controller"
                    >
                      <PhoneOffIcon />
                    </Button>
                  </div>
                </div>
              ) : (
                <Button className="mb-3 h-10 w-full" onClick={() => setPhase("listening")}>
                  <MicIcon />
                  Start voice
                </Button>
              )}

              <form className="flex items-center gap-2" onSubmit={submit}>
                <Input
                  nativeInput
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Tell the controller what to do…"
                  aria-label="Message"
                />
                <Button
                  size="icon"
                  type="submit"
                  disabled={!draft.trim()}
                  aria-label="Send message"
                >
                  <ArrowUpIcon />
                </Button>
              </form>
              <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                <Volume2Icon className="size-3" />
                Can create, inspect, and manage threads
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
