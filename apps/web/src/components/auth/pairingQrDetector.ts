import zxingReaderWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

export interface PairingQrDetector {
  readonly detect: (image: HTMLVideoElement) => Promise<ReadonlyArray<{ rawValue: string }>>;
}

let detectorPromise: Promise<PairingQrDetector> | null = null;

export function loadPairingQrDetector(): Promise<PairingQrDetector> {
  detectorPromise ??= loadNativeDetector().then(async (nativeDetector) => {
    if (nativeDetector) return nativeDetector;

    return import("barcode-detector/ponyfill").then(
      async ({ BarcodeDetector, prepareZXingModule }) => {
        await prepareZXingModule({
          overrides: {
            locateFile: (path: string, prefix: string) =>
              path.endsWith(".wasm") ? zxingReaderWasmUrl : `${prefix}${path}`,
          },
        });
        return new BarcodeDetector({ formats: ["qr_code"] });
      },
    );
  });
  return detectorPromise;
}

async function loadNativeDetector(): Promise<PairingQrDetector | null> {
  const NativeBarcodeDetector = (
    globalThis as typeof globalThis & {
      readonly BarcodeDetector?: {
        readonly getSupportedFormats: () => Promise<ReadonlyArray<string>>;
        new (options: { readonly formats: ReadonlyArray<string> }): PairingQrDetector;
      };
    }
  ).BarcodeDetector;

  if (!NativeBarcodeDetector) return null;

  try {
    const supportedFormats = await NativeBarcodeDetector.getSupportedFormats();
    return supportedFormats.includes("qr_code")
      ? new NativeBarcodeDetector({ formats: ["qr_code"] })
      : null;
  } catch {
    return null;
  }
}
