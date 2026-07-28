import { describe, expect, it, vi } from "vite-plus/test";

import {
  SpeechPlaybackController,
  type SpeechPlaybackDependencies,
} from "./SpeechPlaybackController";

class FakeAudio {
  currentTime = 0;
  readonly listeners = new Map<string, EventListenerOrEventListenerObject>();
  readonly pause = vi.fn();
  readonly play = vi.fn(async () => {});

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emit(type: string) {
    const listener = this.listeners.get(type);
    if (typeof listener === "function") {
      listener(new Event(type));
    } else {
      listener?.handleEvent(new Event(type));
    }
  }
}

function makeHarness(
  requestAudio: SpeechPlaybackDependencies["requestAudio"] = async () =>
    new Blob([new Uint8Array([1])], { type: "audio/mpeg" }),
) {
  const audios: FakeAudio[] = [];
  const revoked: string[] = [];
  const errors: Error[] = [];
  let objectUrlIndex = 0;
  const controller = new SpeechPlaybackController({
    requestAudio,
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
    createObjectUrl: () => `blob:speech-${++objectUrlIndex}`,
    revokeObjectUrl: (url) => revoked.push(url),
    onError: (error) => errors.push(error),
  });
  return { audios, controller, errors, revoked };
}

describe("SpeechPlaybackController", () => {
  it("moves from loading to playing and stops the active message on a second toggle", async () => {
    const harness = makeHarness();
    const playback = harness.controller.toggle("message-1", "Read this.");
    expect(harness.controller.getSnapshot()).toEqual({
      status: "loading",
      messageId: "message-1",
    });

    await playback;
    expect(harness.controller.getSnapshot()).toEqual({
      status: "playing",
      messageId: "message-1",
    });

    await harness.controller.toggle("message-1", "Read this.");
    expect(harness.controller.getSnapshot()).toEqual({
      status: "idle",
      messageId: null,
    });
    expect(harness.audios[0]?.pause).toHaveBeenCalledOnce();
    expect(harness.revoked).toEqual(["blob:speech-1"]);
  });

  it("aborts stale synthesis before starting another message", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(blob: Blob) => void> = [];
    const harness = makeHarness((_input, signal) => {
      signals.push(signal);
      return new Promise<Blob>((resolve) => resolvers.push(resolve));
    });

    const first = harness.controller.toggle("message-1", "First.");
    const second = harness.controller.toggle("message-2", "Second.");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    resolvers[0]?.(new Blob([new Uint8Array([1])]));
    resolvers[1]?.(new Blob([new Uint8Array([2])]));
    await Promise.all([first, second]);
    expect(harness.controller.getSnapshot()).toEqual({
      status: "playing",
      messageId: "message-2",
    });
    expect(harness.audios).toHaveLength(1);
  });

  it("cleans up object URLs when playback ends", async () => {
    const harness = makeHarness();
    await harness.controller.toggle("message-1", "Read this.");
    harness.audios[0]?.emit("ended");

    expect(harness.controller.getSnapshot()).toEqual({
      status: "idle",
      messageId: null,
    });
    expect(harness.revoked).toEqual(["blob:speech-1"]);
  });

  it("recovers from request and audio playback failures", async () => {
    const requestFailure = makeHarness(async () => {
      throw new Error("Provider unavailable.");
    });
    await expect(requestFailure.controller.toggle("message-1", "Read this.")).rejects.toThrow(
      "Provider unavailable.",
    );
    expect(requestFailure.controller.getSnapshot().status).toBe("idle");

    const audioFailure = makeHarness();
    await audioFailure.controller.toggle("message-2", "Read this.");
    audioFailure.audios[0]?.emit("error");
    expect(audioFailure.controller.getSnapshot().status).toBe("idle");
    expect(audioFailure.errors[0]?.message).toBe("The generated audio could not be played.");
  });
});
