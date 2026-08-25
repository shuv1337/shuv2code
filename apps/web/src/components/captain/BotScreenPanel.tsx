import type { BotId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { MaximizeIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { adeEnvironment, useAdeBotScreen, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotScreenViewer } from "../fleet/BotScreenViewer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { getBotScreenPanelView } from "./botScreenPanel.logic";

/**
 * The right rail's screen thumbnail (MESSENGER-PIVOT §2, M6).
 *
 * A second consumer of the *same* helpers the Screen tab uses — the phase
 * machine in `fleet/BotScreenTab.logic.ts` and the viewer in
 * `fleet/BotScreenViewer.tsx` — never a second copy. Two consequences worth
 * naming:
 *
 * - **Viewing never provisions.** The rail mounts wherever a conversation is
 *   open, so if opening it could start a desktop, every captain who widened
 *   their window would be paying for containers they never asked for. The only
 *   thing that starts one is the Start button below, exactly as in the tab.
 * - **Presence is the socket, so the rail feeds the idle policy the same way.**
 *   The server counts attached viewers by relayed-socket lifetime; because the
 *   thumbnail mounts `BotScreenViewer`, watching from the rail holds a desktop
 *   against the idle stop just as watching from the tab does, and closing the
 *   rail detaches. Nothing here calls an attach RPC — there isn't one, and
 *   inventing one would be a second, divergent presence signal.
 */
export function BotScreenPanel({
  botId,
  botName,
}: {
  readonly botId: BotId;
  readonly botName: string;
}) {
  const environmentId = useAdeEnvironmentId();
  const screen = useAdeBotScreen(botId);
  const startDesktop = useAtomCommand(adeEnvironment.startBotDesktop, { reportFailure: false });
  const stopDesktop = useAtomCommand(adeEnvironment.stopBotDesktop, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (screen.data === null) {
    return (
      <section aria-label="Bot screen" className="flex flex-col gap-2 p-3">
        <Skeleton className="h-40 w-full rounded-lg" />
      </section>
    );
  }

  const view = getBotScreenPanelView({ screen: screen.data, botName });

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
    <section aria-label={view.title} className="flex flex-col gap-2 border-b border-border p-3">
      <div className="flex items-center gap-2">
        <MonitorIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="truncate text-sm font-semibold">{view.title}</h2>
        {view.viewersLabel === null ? null : (
          <Badge size="sm" variant="secondary">
            {view.viewersLabel}
          </Badge>
        )}
      </div>

      {view.viewerPath === null ? (
        /*
         * The idle poster. It states the phase and offers the one action that
         * changes it; it is not a dead placeholder, and it is not a viewer
         * waiting to connect to a desktop that does not exist.
         */
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-3">
          <p className="text-sm font-medium">{view.headline}</p>
          <p className="text-xs text-muted-foreground">{view.detail}</p>
        </div>
      ) : (
        <button
          aria-label={view.expandLabel}
          className="group relative block w-full overflow-hidden rounded-lg border border-border bg-black text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setExpanded(true)}
          type="button"
        >
          {/*
           * `pointer-events-none` is what makes this a *thumbnail* rather than
           * a tiny remote desktop: noVNC would otherwise take the click and
           * send it to the bot's session, so the captain would be typing into
           * the bot's screen by trying to enlarge it.
           */}
          <span className="pointer-events-none block">
            <BotScreenViewer surfaceClassName="h-40 w-full" viewerPath={view.viewerPath} />
          </span>
          <span className="absolute end-2 top-2 rounded-md bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <MaximizeIcon aria-hidden className="size-4" />
          </span>
        </button>
      )}

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

      {view.startLabel === null && view.stopLabel === null ? null : (
        <div className="flex flex-wrap gap-2">
          {view.startLabel === null ? null : (
            <Button
              disabled={busy}
              onClick={() => void run(startDesktop, "The desktop could not be started.")}
              size="sm"
            >
              {view.startLabel}
            </Button>
          )}
          {view.stopLabel === null ? null : (
            <Button
              disabled={busy}
              onClick={() => void run(stopDesktop, "The desktop could not be stopped.")}
              size="sm"
              variant="outline"
            >
              {view.stopLabel}
            </Button>
          )}
        </div>
      )}

      {/*
       * The fullscreen dialog mounts its *own* viewer rather than reparenting
       * the thumbnail's: an RFB session cannot be moved across the DOM without
       * tearing down its canvas, and a second attached viewer for the seconds
       * the dialog is open is exactly what the presence counter is for. This
       * one is interactive — enlarging the screen is how a captain takes over.
       */}
      {view.canExpand && expanded && view.viewerPath !== null ? (
        <Dialog onOpenChange={setExpanded} open>
          <DialogPopup className="flex h-[90vh] w-[95vw] max-w-none flex-col gap-2 p-4">
            <DialogTitle className="text-sm font-semibold">{view.fullscreenTitle}</DialogTitle>
            <BotScreenViewer
              className="min-h-0 flex-1"
              surfaceClassName="h-full w-full"
              viewerPath={view.viewerPath}
            />
          </DialogPopup>
        </Dialog>
      ) : null}
    </section>
  );
}
