import { describe, expect, it } from "vite-plus/test";

import { buildRealtimeProbeCases, parseProbeOptions } from "./probe-codex-realtime.ts";

describe("Codex realtime probe", () => {
  it("builds controlled production, model, and protocol-version variants", () => {
    const cases = buildRealtimeProbeCases("gpt-realtime");

    expect(cases.map((probeCase) => probeCase.name)).toEqual([
      "production-v3",
      "production-v3-explicit-model",
      "minimal-v3",
      "minimal-v3-explicit-model",
      "minimal-no-version",
      "minimal-v2",
      "minimal-v1",
    ]);
    expect(
      cases.find((probeCase) => probeCase.name === "production-v3")?.startParams,
    ).not.toHaveProperty("model");
    expect(
      cases.find((probeCase) => probeCase.name === "production-v3-explicit-model")?.startParams,
    ).toMatchObject({ model: "gpt-realtime", version: "v3" });
  });

  it("parses binary, model, timeout, case, and JSON overrides", () => {
    expect(
      parseProbeOptions([
        "--codex",
        "/tmp/codex",
        "--cwd",
        "/tmp/project",
        "--thread-model",
        "gpt-5.4",
        "--realtime-model",
        "gpt-realtime-1",
        "--timeout-ms",
        "20000",
        "--cases",
        "minimal-v3,minimal-v2",
        "--json",
      ]),
    ).toEqual({
      codexBinary: "/tmp/codex",
      cwd: "/tmp/project",
      threadModel: "gpt-5.4",
      realtimeModel: "gpt-realtime-1",
      timeoutMs: 20_000,
      caseNames: new Set(["minimal-v3", "minimal-v2"]),
      json: true,
    });
  });

  it("builds WebRTC cases from encoded offer SDP", () => {
    const offerSdp = "v=0\r\na=group:BUNDLE 0\r\n";
    const options = parseProbeOptions([
      "--offer-sdp-base64",
      Buffer.from(offerSdp).toString("base64"),
    ]);
    const cases = buildRealtimeProbeCases(options.realtimeModel, options.offerSdp);

    expect(cases[0]?.startParams.transport).toEqual({ type: "webrtc", sdp: offerSdp });
  });

  it("rejects unsafe timeout values", () => {
    expect(() => parseProbeOptions(["--timeout-ms", "999"])).toThrow(
      "--timeout-ms must be an integer of at least 1000",
    );
  });

  it("rejects unknown arguments", () => {
    expect(() => parseProbeOptions(["--not-a-probe-option"])).toThrow(
      "Unknown or incomplete argument: --not-a-probe-option",
    );
  });
});
