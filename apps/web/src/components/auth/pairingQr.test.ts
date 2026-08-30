import { describe, expect, it } from "vite-plus/test";

import { InvalidPairingQrError, resolveScannedPairingTarget } from "./pairingQr";

describe("resolveScannedPairingTarget", () => {
  const currentUrl = new URL("https://phone.example.test/pair");

  it("extracts the credential from a pairing link for the current environment", () => {
    expect(
      resolveScannedPairingTarget(
        "https://phone.example.test/pair#token=one-time-credential",
        currentUrl,
      ),
    ).toEqual({
      _tag: "CurrentEnvironment",
      credential: "one-time-credential",
    });
  });

  it("preserves a pairing link that points at another environment", () => {
    expect(
      resolveScannedPairingTarget(
        "https://workstation.example.test/pair#token=remote-credential",
        currentUrl,
      ),
    ).toEqual({
      _tag: "RemoteEnvironment",
      url: "https://workstation.example.test/pair#token=remote-credential",
    });
  });

  it.each([
    "not a URL",
    "javascript:alert(1)",
    "https://phone.example.test/",
    "https://phone.example.test/pair",
  ])("rejects a non-pairing QR value: %s", (rawValue) => {
    expect(() => resolveScannedPairingTarget(rawValue, currentUrl)).toThrow(InvalidPairingQrError);
  });
});
