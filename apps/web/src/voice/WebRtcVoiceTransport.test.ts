import { describe, expect, it, vi } from "vite-plus/test";

import {
  WebRtcVoiceTransport,
  type WebRtcVoiceTransportDependencies,
} from "./WebRtcVoiceTransport";

class FakeEventTarget {
  readonly listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("WebRtcVoiceTransport", () => {
  it("uses a pre-acquired microphone stream without requesting a second one", async () => {
    const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const dataChannel = Object.assign(new FakeEventTarget(), { close: vi.fn() });
    const peer = Object.assign(new FakeEventTarget(), {
      iceGatheringState: "complete",
      connectionState: "connected",
      localDescription: null as RTCSessionDescription | null,
      createDataChannel: vi.fn(() => dataChannel),
      addTrack: vi.fn(),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
        peer.localDescription = description as RTCSessionDescription;
      }),
      setRemoteDescription: vi.fn(async () => {}),
      close: vi.fn(),
    });
    const getUserMedia = vi.fn();
    const transport = new WebRtcVoiceTransport({
      getUserMedia,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudioElement: () =>
        ({
          autoplay: false,
          style: {},
          srcObject: null,
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
          play: vi.fn(async () => {}),
          pause: vi.fn(),
        }) as unknown as HTMLAudioElement,
    });

    await transport.connect({ exchangeOffer: async () => "answer", onData: vi.fn() }, stream);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(peer.addTrack).toHaveBeenCalledWith(track, stream);
    transport.close();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("creates oai-events before the offer and releases every browser resource once", async () => {
    const order: string[] = [];
    const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };
    const dataChannel = Object.assign(new FakeEventTarget(), { close: vi.fn() });
    const peer = Object.assign(new FakeEventTarget(), {
      iceGatheringState: "complete",
      connectionState: "connected",
      localDescription: null as RTCSessionDescription | null,
      createDataChannel: vi.fn(() => {
        order.push("data-channel");
        return dataChannel;
      }),
      addTrack: vi.fn(),
      createOffer: vi.fn(async () => {
        order.push("offer");
        return { type: "offer", sdp: "offer-sdp" };
      }),
      setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
        peer.localDescription = description as RTCSessionDescription;
      }),
      setRemoteDescription: vi.fn(async () => {}),
      close: vi.fn(),
    });
    const audio = {
      autoplay: false,
      style: { display: "" },
      srcObject: null,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      play: vi.fn(async () => {}),
      pause: vi.fn(),
    };
    const dependencies: WebRtcVoiceTransportDependencies = {
      getUserMedia: vi.fn(async () => stream as unknown as MediaStream),
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
    };
    const transport = new WebRtcVoiceTransport(dependencies);

    await transport.connect({
      exchangeOffer: async (offer) => {
        expect(offer).toBe("offer-sdp");
        return "answer-sdp";
      },
      onData: vi.fn(),
    });

    expect(order).toEqual(["data-channel", "offer"]);
    expect(dependencies.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    transport.setMuted(true);
    expect(track.enabled).toBe(false);
    transport.close();
    transport.close();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(dataChannel.close).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
  });

  it("times out ICE gathering and removes its listener", async () => {
    const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
    const peer = Object.assign(new FakeEventTarget(), {
      iceGatheringState: "gathering",
      connectionState: "new",
      localDescription: null as RTCSessionDescription | null,
      createDataChannel: () => Object.assign(new FakeEventTarget(), { close: vi.fn() }),
      addTrack: vi.fn(),
      createOffer: async () => ({ type: "offer", sdp: "offer" }),
      setLocalDescription: async (description: RTCSessionDescriptionInit) => {
        peer.localDescription = description as RTCSessionDescription;
      },
      setRemoteDescription: vi.fn(),
      close: vi.fn(),
    });
    const transport = new WebRtcVoiceTransport({
      getUserMedia: async () =>
        ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }) as unknown as MediaStream,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudioElement: () =>
        ({
          style: {},
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
          play: vi.fn(),
          pause: vi.fn(),
          srcObject: null,
        }) as unknown as HTMLAudioElement,
      iceGatheringTimeoutMs: 1,
    });

    await expect(
      transport.connect({ exchangeOffer: vi.fn(), onData: vi.fn() }),
    ).rejects.toMatchObject({ code: "ice-gathering-timeout" });
    expect(peer.listeners.get("icegatheringstatechange")?.size ?? 0).toBe(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-progress ICE wait when stopped", async () => {
    const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
    const peer = Object.assign(new FakeEventTarget(), {
      iceGatheringState: "gathering",
      connectionState: "new",
      localDescription: null as RTCSessionDescription | null,
      createDataChannel: () => Object.assign(new FakeEventTarget(), { close: vi.fn() }),
      addTrack: vi.fn(),
      createOffer: async () => ({ type: "offer", sdp: "offer" }),
      setLocalDescription: async (description: RTCSessionDescriptionInit) => {
        peer.localDescription = description as RTCSessionDescription;
      },
      setRemoteDescription: vi.fn(),
      close: vi.fn(),
    });
    const transport = new WebRtcVoiceTransport({
      getUserMedia: async () =>
        ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }) as unknown as MediaStream,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudioElement: () =>
        ({
          style: {},
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
          play: vi.fn(),
          pause: vi.fn(),
          srcObject: null,
        }) as unknown as HTMLAudioElement,
      iceGatheringTimeoutMs: 30_000,
    });
    const connecting = transport.connect({ exchangeOffer: vi.fn(), onData: vi.fn() });
    await vi.waitFor(() => expect(peer.listeners.get("icegatheringstatechange")?.size).toBe(1));

    transport.close();

    await expect(connecting).rejects.toMatchObject({ code: "transport-closed" });
    expect(peer.listeners.get("icegatheringstatechange")?.size ?? 0).toBe(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("reports microphone removal and actionable remote autoplay failure", async () => {
    const track = Object.assign(new FakeEventTarget(), {
      enabled: true,
      stop: vi.fn(),
    });
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };
    const peer = Object.assign(new FakeEventTarget(), {
      iceGatheringState: "complete",
      connectionState: "connected",
      localDescription: null as RTCSessionDescription | null,
      createDataChannel: () => Object.assign(new FakeEventTarget(), { close: vi.fn() }),
      addTrack: vi.fn(),
      createOffer: async () => ({ type: "offer", sdp: "offer" }),
      setLocalDescription: async (description: RTCSessionDescriptionInit) => {
        peer.localDescription = description as RTCSessionDescription;
      },
      setRemoteDescription: vi.fn(),
      close: vi.fn(),
    });
    const audio = {
      autoplay: false,
      style: {},
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      play: vi.fn(async () => {
        throw new Error("gesture required");
      }),
      pause: vi.fn(),
      srcObject: null,
    };
    const onData = vi.fn();
    const onMicrophoneEnded = vi.fn();
    const transport = new WebRtcVoiceTransport({
      getUserMedia: async () => stream as unknown as MediaStream,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
    });

    await transport.connect({
      exchangeOffer: async () => "answer",
      onData,
      onMicrophoneEnded,
    });
    track.dispatch("ended");
    peer.dispatch("track", {
      streams: [{} as MediaStream],
      track: {} as MediaStreamTrack,
    });

    expect(onMicrophoneEnded).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(onData).toHaveBeenCalledWith(
        JSON.stringify({
          type: "client.playback-error",
          message: "gesture required",
        }),
      ),
    );
  });
});
