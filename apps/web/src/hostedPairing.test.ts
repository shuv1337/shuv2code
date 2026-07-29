import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  configuredHostedAppUrl,
  hasHostedPairingRequest,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has no hosted origin unless one is explicitly configured", () => {
    expect(configuredHostedAppUrl()).toBeNull();
    expect(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
      }),
    ).toBeNull();
    expect(buildHostedChannelSelectionUrl({ channel: "latest" })).toBeNull();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.shuv2code.example/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.shuv2code.example");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      })!,
    );

    expect(url.origin).toBe("https://preview.shuv2code.example");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("builds hosted channel selection URLs through the configured router origin", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.shuv2code.example");

    const url = new URL(
      buildHostedChannelSelectionUrl({
        channel: "nightly",
      })!,
    );

    expect(url.origin).toBe("https://app.shuv2code.example");
    expect(url.pathname).toBe("/__shuv2code/channel");
    expect(url.searchParams.get("channel")).toBe("nightly");
    expect(url.searchParams.has("next")).toBe(false);
  });

  it("ignores incomplete hosted pairing requests", () => {
    expect(
      hasHostedPairingRequest(
        new URL("https://app.shuv2code.example/pair?host=backend.example.com"),
      ),
    ).toBe(false);
    expect(
      hasHostedPairingRequest(new URL("https://app.shuv2code.example/pair?token=ABCD1234")),
    ).toBe(false);
  });

  it("detects the hosted static app only when no backend URL is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.shuv2code.example");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://preview.shuv2code.example/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://preview.shuv2code.example/pair"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://backend.example.com/"))).toBe(false);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://preview.shuv2code.example/"))).toBe(false);
  });

  it("detects hosted channel aliases as static apps", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.shuv2code.example");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://nightly.app.shuv2code.example/"))).toBe(true);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://nightly.app.shuv2code.example/"))).toBe(false);
  });
});
