import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceActivityMonitor } from "./VoiceActivityMonitor";

class FakeAnalyser {
  fftSize = 32;
  smoothingTimeConstant = 0;
  level = 0;

  getFloatTimeDomainData(samples: Float32Array<ArrayBuffer>): void {
    samples.fill(this.level);
  }
}

function mediaStream(level: number): MediaStream {
  return { level } as unknown as MediaStream;
}

function streamLevel(stream: MediaStream): number {
  return (stream as unknown as { level: number }).level;
}

function harness() {
  const scheduled = new Map<number, () => void>();
  let nextTimer = 0;
  let now = 0;
  let visible = true;
  let visibilityListener: (() => void) | null = null;
  const contexts: Array<{
    readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    readonly resume: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }> = [];

  const monitor = new VoiceActivityMonitor({
    createAudioContext: () => {
      const close = vi.fn(async () => undefined);
      const resume = vi.fn(async () => undefined);
      contexts.push({ close, resume });
      return {
        close,
        resume,
        createAnalyser: () => new FakeAnalyser(),
        createMediaStreamSource: (stream) => ({
          connect: (target: FakeAnalyser) => {
            target.level = streamLevel(stream);
          },
        }),
      };
    },
    schedule: (callback) => {
      const timer = ++nextTimer;
      scheduled.set(timer, callback);
      return timer;
    },
    cancel: (timer) => scheduled.delete(timer),
    now: () => now,
    isVisible: () => visible,
    subscribeVisibility: (listener) => {
      visibilityListener = listener;
      return () => {
        visibilityListener = null;
      };
    },
  });

  const sample = () => {
    const entry = scheduled.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No sample was scheduled.");
    scheduled.delete(entry[0]);
    entry[1]();
  };

  return {
    monitor,
    contexts,
    scheduled,
    sample,
    setNow(value: number) {
      now = value;
    },
    setVisible(value: boolean) {
      visible = value;
      visibilityListener?.();
    },
  };
}

describe("VoiceActivityMonitor", () => {
  it("keeps sampling after a presentation subscriber unmounts", async () => {
    const test = harness();
    const listener = vi.fn();
    const unsubscribe = test.monitor.subscribe(listener);

    await test.monitor.attachMicrophone(mediaStream(0.05));
    test.sample();
    expect(test.monitor.activity).toBe("user-speaking");

    unsubscribe();
    test.monitor.attachRemoteAudio(mediaStream(0.08));
    test.sample();

    expect(test.monitor.activity).toBe("assistant-speaking");
    expect(test.monitor.activityLevel.current).toBeGreaterThan(0);
    expect(test.contexts[0]?.close).not.toHaveBeenCalled();
  });

  it("retains remote media that arrives before the microphone on reconnect", async () => {
    const test = harness();
    test.monitor.attachRemoteAudio(mediaStream(0.08));
    await test.monitor.attachMicrophone(mediaStream(0.01));
    test.sample();

    expect(test.monitor.activity).toBe("assistant-speaking");
    expect(test.monitor.activityLevel.current).toBeGreaterThan(0);
  });

  it("pauses in the background and resumes the same signal when visible", async () => {
    const test = harness();
    await test.monitor.attachMicrophone(mediaStream(0.05));
    expect(test.scheduled.size).toBe(1);

    test.setVisible(false);
    expect(test.scheduled.size).toBe(0);

    test.setVisible(true);
    expect(test.monitor.activity).toBe("user-speaking");
    expect(test.scheduled.size).toBe(1);
    expect(test.contexts[0]?.close).not.toHaveBeenCalled();
  });

  it("replaces probes on transport reconnect and disposes only when the session ends", async () => {
    const test = harness();
    await test.monitor.attachMicrophone(mediaStream(0.04));
    await test.monitor.attachMicrophone(mediaStream(0.06));

    expect(test.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(test.contexts[1]?.close).not.toHaveBeenCalled();

    test.setNow(1_000);
    test.monitor.setEnabled(false);
    expect(test.contexts[1]?.close).toHaveBeenCalledOnce();
    expect(test.monitor.activity).toBe("listening");
    expect(test.monitor.activityLevel.current).toBe(0);
    expect(test.scheduled.size).toBe(0);
  });
});
