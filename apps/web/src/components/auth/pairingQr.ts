import { getPairingTokenFromUrl } from "../../pairingUrl";

export type ScannedPairingTarget =
  | { readonly _tag: "CurrentEnvironment"; readonly credential: string }
  | { readonly _tag: "RemoteEnvironment"; readonly url: string };

export class InvalidPairingQrError extends Error {
  override readonly name = "InvalidPairingQrError";

  constructor() {
    super("That QR code is not a shuv2code pairing link.");
  }
}

export function resolveScannedPairingTarget(
  rawValue: string,
  currentUrl: URL,
): ScannedPairingTarget {
  let scannedUrl: URL;
  try {
    scannedUrl = new URL(rawValue.trim());
  } catch {
    throw new InvalidPairingQrError();
  }

  if (
    (scannedUrl.protocol !== "http:" && scannedUrl.protocol !== "https:") ||
    !scannedUrl.pathname.endsWith("/pair")
  ) {
    throw new InvalidPairingQrError();
  }

  const credential = getPairingTokenFromUrl(scannedUrl);
  if (!credential) {
    throw new InvalidPairingQrError();
  }

  if (scannedUrl.origin === currentUrl.origin) {
    return { _tag: "CurrentEnvironment", credential };
  }

  return { _tag: "RemoteEnvironment", url: scannedUrl.toString() };
}
