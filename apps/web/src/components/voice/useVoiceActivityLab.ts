import { useCallback, useEffect, useRef, useState } from "react";

import { VOICE_AGENT_REPLY_DATA_URL } from "./voiceAgentReply";
import type { VoicePresencePhase } from "./voicePresenceTheme";

export type VoiceLabSignalMode = "showcase" | "transcription" | "playback" | "realtime";

interface AudioProbe {
  readonly analyser: AnalyserNode;
  readonly samples: Float32Array<ArrayBuffer>;
}

interface AudioSignal {
  readonly context: AudioContext;
  readonly input: AudioProbe;
  output?: AudioProbe;
  readonly audio?: HTMLAudioElement;
}

function sampledLevel(probe: AudioProbe): number {
  probe.analyser.getFloatTimeDomainData(probe.samples);
  let sum = 0;
  for (const sample of probe.samples) sum += sample * sample;
  const rms = Math.sqrt(sum / probe.samples.length);
  return Math.min(1, Math.max(0, (rms - 0.008) * 10.5));
}

function createStreamProbe(context: AudioContext, stream: MediaStream): AudioProbe {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  context.createMediaStreamSource(stream).connect(analyser);
  return { analyser, samples: new Float32Array(analyser.fftSize) };
}

function showcaseLevel(phase: VoicePresencePhase, seconds: number): number {
  if (phase === "idle" || phase === "muted") return 0;
  if (phase === "thinking") return 0.035 + Math.sin(seconds * 0.7) * 0.012;

  const cadence =
    Math.sin(seconds * 5.1) * 0.24 +
    Math.sin(seconds * 8.7 + 1.2) * 0.15 +
    Math.sin(seconds * 13.9 + 0.4) * 0.08;
  const phrase = 0.56 + Math.sin(seconds * 1.34 + 0.8) * 0.34;
  const base = phase === "speaking" ? 0.34 : 0.25;
  return Math.min(0.78, Math.max(0.025, base + cadence * Math.max(0.18, phrase)));
}

export function useVoiceActivityLab(
  phase: VoicePresencePhase,
  onPhaseChange: (phase: VoicePresencePhase) => void,
) {
  const activityLevel = useRef(0);
  const phaseRef = useRef(phase);
  const signalRef = useRef<AudioSignal | null>(null);
  const remoteSpeakingUntilRef = useRef(0);
  const [mode, setMode] = useState<VoiceLabSignalMode>("showcase");
  const [error, setError] = useState<string | null>(null);
  phaseRef.current = phase;

  const disposeSignal = useCallback(() => {
    const signal = signalRef.current;
    signalRef.current = null;
    remoteSpeakingUntilRef.current = 0;
    if (!signal) return;
    signal.audio?.pause();
    if (signal.audio) signal.audio.src = "";
    void signal.context.close().catch(() => undefined);
  }, []);

  const useShowcase = useCallback(() => {
    disposeSignal();
    setError(null);
    setMode("showcase");
  }, [disposeSignal]);

  const useProviderTranscription = useCallback(
    async (stream: MediaStream) => {
      disposeSignal();
      setError(null);
      try {
        const context = new AudioContext();
        const signal: AudioSignal = {
          context,
          input: createStreamProbe(context, stream),
        };
        signalRef.current = signal;
        await context.resume();
        setMode("transcription");
        onPhaseChange("listening");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Microphone access failed.";
        setError(message);
        setMode("showcase");
        throw new Error(message, { cause });
      }
    },
    [disposeSignal, onPhaseChange],
  );

  const useRealtime = useCallback(
    async (microphoneStream: MediaStream) => {
      disposeSignal();
      setError(null);
      try {
        const context = new AudioContext();
        signalRef.current = {
          context,
          input: createStreamProbe(context, microphoneStream),
        };
        await context.resume();
        setMode("realtime");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Voice activity setup failed.";
        disposeSignal();
        setError(message);
        setMode("showcase");
        throw new Error(message, { cause });
      }
    },
    [disposeSignal],
  );

  const attachRealtimeOutput = useCallback((stream: MediaStream) => {
    const signal = signalRef.current;
    if (!signal) return;
    signal.output = createStreamProbe(signal.context, stream);
    void signal.context.resume().catch(() => undefined);
  }, []);

  const playReply = useCallback(async () => {
    disposeSignal();
    setError(null);
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.68;
      const audio = new Audio(VOICE_AGENT_REPLY_DATA_URL);
      audio.preload = "auto";
      const source = context.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(context.destination);
      signalRef.current = {
        context,
        input: { analyser, samples: new Float32Array(analyser.fftSize) },
        audio,
      };
      audio.addEventListener(
        "ended",
        () => {
          activityLevel.current = 0;
          disposeSignal();
          setMode("showcase");
          onPhaseChange("listening");
        },
        { once: true },
      );
      await context.resume();
      await audio.play();
      setMode("playback");
      onPhaseChange("speaking");
    } catch (cause) {
      disposeSignal();
      setError(cause instanceof Error ? cause.message : "Reply playback failed.");
      setMode("showcase");
    }
  }, [disposeSignal, onPhaseChange]);

  useEffect(() => {
    let timer = 0;
    const startedAt = performance.now();
    const schedule = () => {
      const ambient =
        signalRef.current === null &&
        mode === "showcase" &&
        (phaseRef.current === "idle" || phaseRef.current === "muted");
      timer = window.setTimeout(sample, ambient ? 1_000 / 6 : 1_000 / 30);
    };
    const sample = () => {
      timer = 0;
      if (document.visibilityState !== "visible") return;
      const now = performance.now();
      const signal = signalRef.current;
      if (!signal) {
        activityLevel.current =
          mode === "showcase" ? showcaseLevel(phaseRef.current, (now - startedAt) / 1_000) : 0;
        schedule();
        return;
      }

      const inputLevel = sampledLevel(signal.input);
      const outputLevel = signal.output ? sampledLevel(signal.output) : 0;
      if (mode !== "realtime") {
        activityLevel.current = inputLevel;
        schedule();
        return;
      }

      if (outputLevel > 0.012) {
        remoteSpeakingUntilRef.current = now + 420;
        if (phaseRef.current !== "speaking") {
          phaseRef.current = "speaking";
          onPhaseChange("speaking");
        }
      } else if (
        phaseRef.current === "speaking" &&
        remoteSpeakingUntilRef.current > 0 &&
        now > remoteSpeakingUntilRef.current
      ) {
        remoteSpeakingUntilRef.current = 0;
        phaseRef.current = "listening";
        onPhaseChange("listening");
      }
      activityLevel.current =
        phaseRef.current === "speaking" && signal.output ? outputLevel : inputLevel;
      schedule();
    };
    const handleVisibilityChange = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (document.visibilityState === "visible") sample();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    sample();
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [mode, onPhaseChange]);

  useEffect(() => disposeSignal, [disposeSignal]);

  return {
    activityLevel,
    attachRealtimeOutput,
    error,
    mode,
    playReply,
    useProviderTranscription,
    useRealtime,
    useShowcase,
  };
}
