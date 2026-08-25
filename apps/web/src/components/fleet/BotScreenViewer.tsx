import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { WEBSOCKET_TICKET_PATH, viewerSocketUrl } from "./BotScreenTab.logic";

/**
 * Mounts noVNC against the ADE-terminated proxy.
 *
 * Keyed by `viewerPath` upstream so a different bot — or the same bot after a
 * restart — gets a fresh RFB session rather than a reused one pointed at a
 * port that has since changed hands.
 *
 * **This component is the presence signal.** The server counts attached
 * viewers by the lifetime of the relayed WebSocket (`AdeScreenViewerRoute`
 * brackets `viewerAttached`/`viewerDetached` around the socket), and those
 * viewers are what hold a desktop against the idle stop. So there is exactly
 * one way to attach — mount this — and every consumer that wants presence to
 * behave the way the Screen tab's does must go through it rather than opening
 * its own socket. The captain right rail (`BotScreenPanel`, MESSENGER-PIVOT
 * §2) is the second consumer; it is why this moved out of `BotScreenTab.tsx`.
 */
export function BotScreenViewer({
  viewerPath,
  className,
  surfaceClassName,
}: {
  readonly viewerPath: string;
  /** Wrapper class, so a rail thumbnail and a full tab can size differently. */
  readonly className?: string;
  /** Class for the RFB surface itself — the element noVNC scales into. */
  readonly surfaceClassName?: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const target = container.current;
    if (target === null) return;
    let disposed = false;
    let client: { disconnect: () => void } | null = null;

    const connect = async (): Promise<void> => {
      // A WebSocket cannot carry an Authorization header, so the upgrade is
      // authenticated by a short-lived ticket minted here — the same mechanism
      // the RPC socket uses. Without it, every client that is not a plain
      // cookie-bearing browser tab is refused with a 401 the viewer cannot
      // explain.
      const response = await fetch(WEBSOCKET_TICKET_PATH, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? "Your session is not authorized to view desktops. Sign in again."
            : `The viewer could not be authorized (HTTP ${response.status}).`,
        );
      }
      const { ticket } = (await response.json()) as { ticket: string };
      if (disposed) return;

      // Loaded lazily: noVNC is a large, browser-only bundle and no other
      // surface in the app needs it, so it must not sit in the main chunk.
      const { default: RFB } = await import("@novnc/novnc/lib/rfb.js");
      if (disposed) return;
      const rfb = new RFB(
        target,
        viewerSocketUrl({ pageOrigin: window.location.origin, viewerPath, wsTicket: ticket }),
      );
      // Scale rather than resize: asking the desktop to match the panel would
      // change the resolution the bot's own screenshots are taken at, so what
      // the captain watches would not be what the model sees. This is also
      // what lets the same viewer be a 470px rail thumbnail and a fullscreen
      // dialog without two rendering paths.
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "transparent";
      rfb.addEventListener("connect", () => {
        setFailure(null);
        setStatus("connected");
      });
      rfb.addEventListener("disconnect", () => setStatus("disconnected"));
      client = rfb;
    };

    void connect().catch((cause: unknown) => {
      if (disposed) return;
      setStatus("disconnected");
      setFailure(cause instanceof Error ? cause.message : "The viewer could not connect.");
    });

    return () => {
      disposed = true;
      client?.disconnect();
    };
  }, [viewerPath]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {failure === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {failure}
        </p>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-black">
        <div
          ref={container}
          className={cn("h-[28rem] w-full", surfaceClassName)}
          data-testid="ade-vnc-viewport"
        />
        {status === "connected" ? null : (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {status === "connecting" ? "Connecting to the desktop…" : (failure ?? "Disconnected.")}
          </p>
        )}
      </div>
    </div>
  );
}
