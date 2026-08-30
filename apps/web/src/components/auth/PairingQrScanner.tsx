import { CameraIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { loadPairingQrDetector } from "./pairingQrDetector";

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 1280 },
  },
};

const SCAN_INTERVAL_MS = 180;

export function PairingQrScanner({
  onClose,
  onDetected,
}: {
  readonly onClose: () => void;
  readonly onDetected: (rawValue: string) => boolean | Promise<boolean>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [statusMessage, setStatusMessage] = useState("Starting camera...");
  const [hasCameraError, setHasCameraError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let scanTimer: number | null = null;

    const stopCamera = () => {
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer);
      }
      stream?.getTracks().forEach((track) => track.stop());
      if (video) {
        video.srcObject = null;
      }
    };

    const scheduleScan = (detector: Awaited<ReturnType<typeof loadPairingQrDetector>>): void => {
      scanTimer = window.setTimeout(() => {
        void scanFrame(detector);
      }, SCAN_INTERVAL_MS);
    };

    const scanFrame = async (
      detector: Awaited<ReturnType<typeof loadPairingQrDetector>>,
    ): Promise<void> => {
      if (cancelled || !video) return;

      try {
        const results = await detector.detect(video);
        const rawValue = results.find((result) => result.rawValue.trim().length > 0)?.rawValue;
        if (rawValue) {
          const accepted = await onDetected(rawValue);
          if (accepted) {
            cancelled = true;
            stopCamera();
            return;
          }
          setStatusMessage("That QR code is not a shuv2code pairing link.");
        }
        scheduleScan(detector);
      } catch (error) {
        if (cancelled) return;
        setHasCameraError(true);
        setStatusMessage(cameraErrorMessage(error));
        stopCamera();
      }
    };

    const startCamera = async (): Promise<void> => {
      if (!video || !navigator.mediaDevices?.getUserMedia) {
        setHasCameraError(true);
        setStatusMessage(
          "Camera scanning requires a secure browser connection with camera access.",
        );
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (cancelled) {
          stopCamera();
          return;
        }

        video.srcObject = stream;
        await video.play();
        const detector = await loadPairingQrDetector();
        if (cancelled) {
          stopCamera();
          return;
        }

        setStatusMessage("Point your camera at a shuv2code pairing QR code.");
        scheduleScan(detector);
      } catch (error) {
        if (cancelled) return;
        setHasCameraError(true);
        setStatusMessage(cameraErrorMessage(error));
        stopCamera();
      }
    };

    void startCamera();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [onDetected]);

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border/80 bg-background/70 sm:hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <CameraIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span>Scan pairing QR</span>
        </div>
        <Button aria-label="Close QR scanner" onClick={onClose} size="icon-sm" variant="ghost">
          <XIcon aria-hidden />
        </Button>
      </div>

      <div className="relative aspect-square w-full overflow-hidden bg-black">
        <video
          aria-label="Camera preview for pairing QR code"
          autoPlay
          className="size-full object-cover"
          muted
          playsInline
          ref={videoRef}
        />
        {!hasCameraError ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-[14%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.28)]"
          />
        ) : null}
      </div>

      <p
        aria-live="polite"
        className={`px-3 py-3 text-xs leading-relaxed ${hasCameraError ? "text-destructive" : "text-muted-foreground"}`}
      >
        {statusMessage}
      </p>
    </div>
  );
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera access was denied. Allow camera access in your browser, then open the scanner again.";
      case "NotFoundError":
        return "No camera is available on this device.";
      case "NotReadableError":
        return "The camera is already in use by another app.";
    }
  }

  return "The camera could not start. Close the scanner and try again.";
}
