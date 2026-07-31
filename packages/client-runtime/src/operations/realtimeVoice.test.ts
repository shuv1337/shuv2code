import { EnvironmentId } from "@shuv2code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  RealtimeVoiceLeaseRelease,
  isMatchingRealtimeVoiceGeneration,
  nextRealtimeVoiceGeneration,
  reconnectRealtimeVoiceGeneration,
  withoutRealtimeVoiceEventReplay,
} from "./realtimeVoice.ts";

describe("realtime voice operations", () => {
  it("keeps one client session while advancing reconnect generations", () => {
    const first = nextRealtimeVoiceGeneration(null, () => "voice-session");
    const second = reconnectRealtimeVoiceGeneration({
      ...first,
      environmentId: EnvironmentId.make("environment"),
    });

    expect(first).toEqual({ clientSessionId: "voice-session", generation: 1 });
    expect(second).toEqual({
      clientSessionId: "voice-session",
      generation: 2,
      environmentId: "environment",
    });
    expect(isMatchingRealtimeVoiceGeneration(first, second)).toBe(false);
  });

  it("releases the server lease exactly once", async () => {
    const release = vi.fn(async () => {});
    const guard = new RealtimeVoiceLeaseRelease();

    expect(await guard.run(release)).toBe(true);
    expect(await guard.run(release)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("allows a failed release to be retried", async () => {
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("socket lost"))
      .mockResolvedValueOnce();
    const guard = new RealtimeVoiceLeaseRelease();

    await expect(guard.run(release)).rejects.toThrow("socket lost");
    expect(guard.released).toBe(false);
    expect(await guard.run(release)).toBe(true);
    expect(guard.released).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("can record a server-confirmed release without issuing another request", async () => {
    const release = vi.fn(async () => {});
    const guard = new RealtimeVoiceLeaseRelease();

    guard.markReleased();

    expect(await guard.run(release)).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it("drops the event cursor when reconnecting instead of replaying client input", () => {
    expect(
      withoutRealtimeVoiceEventReplay({
        clientSessionId: "voice-session" as never,
        generation: 2 as never,
        runtimeInstanceId: "runtime" as never,
        afterSequence: 11 as never,
      }),
    ).toEqual({
      clientSessionId: "voice-session",
      generation: 2,
      runtimeInstanceId: "runtime",
    });
  });
});
