import type { BotId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { MonitorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { adeEnvironment, useAdeBotScreen, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { getBotScreenView, viewerSocketUrl, WEBSOCKET_TICKET_PATH } from "./BotScreenTab.logic";

/**
 * The bot detail Screen tab (spec §4.6).
 *
 * Mounting this tab reads desktop status and nothing more. The noVNC viewer is
 * mounted only once the server has said a desktop is running *and* handed back
 * a viewer path, so opening the tab can never bring a container up — starting
 * one is always the captain pressing Start.
 */
export function BotScreenTab({ botId }: { readonly botId: BotId }) {
  const environmentId = useAdeEnvironmentId();
  const screen = useAdeBotScreen(botId);
  const startDesktop = useAtomCommand(adeEnvironment.startBotDesktop, { reportFailure: false });
  const stopDesktop = useAtomCommand(adeEnvironment.stopBotDesktop, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (screen.data === null) {
    return (
      <section className="flex flex-col gap-3" aria-label="Screen">
        <Skeleton className="h-64 w-full rounded-lg" />
      </section>
    );
  }

  const view = getBotScreenView(screen.data);

  const run = async (command: typeof startDesktop, fallback: string): Promise<void> => {
    if (environmentId === null) return;
    setError(null);
    setBusy(true);
    try {
      const result = await command({ environmentId, input: { botId } });
      if (result._tag === "Failure") {
        setError(adeCaptainErrorMessage(squashAtomCommandFailure(result), fallback));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Screen">
      <div className="flex flex-wrap items-center gap-2">
        <MonitorIcon aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{view.headline}</h2>
        {view.viewers > 0 ? (
          <Badge size="sm" variant="secondary">
            {view.viewers === 1 ? "1 viewer" : `${view.viewers} viewers`}
          </Badge>
        ) : null}
        <div className="ml-auto flex shrink-0 gap-2">
          {view.canStart ? (
            <Button
              disabled={busy}
              size="sm"
              onClick={() => void run(startDesktop, "The desktop could not be started.")}
            >
              Start desktop
            </Button>
          ) : null}
          {view.canStop ? (
            <Button
              disabled={busy}
              size="sm"
              variant="outline"
              onClick={() => void run(stopDesktop, "The desktop could not be stopped.")}
            >
              Stop desktop
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{view.detail}</p>
      {screen.error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {screen.error}
        </p>
      )}
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {view.viewerPath === null ? (
        <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-xs text-muted-foreground">
          Nothing to show yet.
        </div>
      ) : (
        <VncViewer viewerPath={view.viewerPath} />
      )}
    </section>
  );
}

/**
 * Mounts noVNC against the ADE-terminated proxy.
 *
 * Keyed by `viewerPath` upstream so a different bot — or the same bot after a
 * restart — gets a fresh RFB session rather than a reused one pointed at a
 * port that has since changed hands.
 */
function VncViewer({ viewerPath }: { readonly viewerPath: string }) {
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
      // the captain watches would not be what the model sees.
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
    <div className="flex flex-col gap-2">
      {failure === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {failure}
        </p>
      )}
      <div className="relative overflow-hidden rounded-lg border border-border bg-black">
        <div ref={container} className="h-[28rem] w-full" data-testid="ade-vnc-viewport" />
        {status === "connected" ? null : (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {status === "connecting" ? "Connecting to the desktop…" : (failure ?? "Disconnected.")}
          </p>
        )}
      </div>
    </div>
  );
}
