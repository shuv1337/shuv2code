import type { BotId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { MaximizeIcon, MonitorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useElementVisible } from "../../hooks/useElementVisible";
import { adeEnvironment, useAdeBotScreen, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotScreenViewer } from "../fleet/BotScreenViewer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { getBotScreenPanelView } from "./botScreenPanel.logic";
import { botScreenDetachedNote, shouldAttachBotScreenViewer } from "./botScreenPresence";

/**
 * The right rail's screen thumbnail (MESSENGER-PIVOT §2, M6).
 *
 * A second consumer of the *same* helpers the Screen tab uses — the phase
 * machine in `fleet/BotScreenTab.logic.ts` and the viewer in
 * `fleet/BotScreenViewer.tsx` — never a second copy. Three consequences worth
 * naming:
 *
 * - **Viewing never provisions.** The rail mounts wherever a conversation is
 *   open, so if opening it could start a desktop, every captain who widened
 *   their window would be paying for containers they never asked for. The only
 *   thing that starts one is the Start button below, exactly as in the tab.
 * - **Presence is the socket, so an ambient rail must not hold one.** The
 *   server counts attached viewers by relayed-socket lifetime and viewers hold
 *   a desktop against the idle stop. A thumbnail that stayed attached for as
 *   long as a conversation was open would pin a Screenbox slot all night for
 *   nobody. `shouldAttachBotScreenViewer` gates the mount on the panel actually
 *   being looked at; the poster stands in until then.
 * - **The Screen tab's semantics are untouched.** It is a destination — opening
 *   it *is* the act of looking — so it keeps attaching for as long as it is
 *   mounted. Only the ambient surface has to earn its socket.
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

  const sectionRef = useRef<HTMLElement | null>(null);
  // A margin, not a hairline: a thumbnail one scroll-tick from view should
  // already be connecting, or scrolling to it shows a black box for a second.
  const { intersecting, documentHidden } = useElementVisible(sectionRef, { rootMargin: "200px" });

  const view =
    screen.data === null ? null : getBotScreenPanelView({ screen: screen.data, botName });
  const viewerPath = view?.viewerPath ?? null;

  /*
   * A desktop that went away takes the dialog with it. Without this, a blip
   * that nulls `viewerPath` for one poll leaves `expanded` latched, and the
   * fullscreen dialog springs back open by itself the moment the desktop
   * returns — a modal nobody asked for, over a conversation.
   */
  useEffect(() => {
    if (viewerPath === null) setExpanded(false);
  }, [viewerPath]);

  const attach =
    view !== null &&
    shouldAttachBotScreenViewer({
      hasViewerPath: viewerPath !== null,
      intersecting,
      documentHidden,
      // The dialog mounts its own viewer. Keeping the thumbnail's open too
      // would count one human twice against the desktop's viewer total.
      fullscreenOpen: expanded,
    });

  if (view === null) {
    return (
      <section aria-label="Bot screen" className="flex flex-col gap-2 p-3" ref={sectionRef}>
        <Skeleton className="h-40 w-full rounded-lg" />
      </section>
    );
  }

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

  const detachedNote = botScreenDetachedNote({
    hasViewerPath: viewerPath !== null,
    fullscreenOpen: expanded,
  });

  return (
    <section
      aria-label={view.title}
      className="flex flex-col gap-2 border-b border-border p-3"
      ref={sectionRef}
    >
      <div className="flex items-center gap-2">
        <MonitorIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="truncate text-sm font-semibold">{view.title}</h2>
        {view.viewersLabel === null ? null : (
          <Badge size="sm" variant="secondary">
            {view.viewersLabel}
          </Badge>
        )}
      </div>

      {attach && viewerPath !== null ? (
        <BotScreenViewer
          frameClassName="min-h-0 flex-1"
          overlay={
            /*
             * The click target lives *inside* the viewer's frame rather than
             * wrapped around it. Wrapping would put `<div>`s and a
             * `role="alert"` inside a `<button>` — invalid markup, and an
             * error announced as part of a button label instead of as an
             * error. As a bonus this is also what stops the click reaching
             * noVNC: without a layer over the canvas, clicking to enlarge
             * would be typing into the bot's session.
             */
            <button
              aria-label={view.expandLabel}
              className="group absolute inset-0 cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => setExpanded(true)}
              type="button"
            >
              <span className="absolute end-2 top-2 rounded-md bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <MaximizeIcon aria-hidden className="size-4" />
              </span>
            </button>
          }
          surfaceClassName="h-40 w-full"
          viewerPath={viewerPath}
        />
      ) : (
        /*
         * The idle poster, which also stands in whenever the viewer is
         * detached. It states the phase and offers the action that changes it;
         * it is not a dead placeholder waiting on a desktop that does not
         * exist, and — via `detachedNote` — it does not claim "no desktop
         * running" at a desktop that is running and merely unwatched.
         */
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-3">
          <p className="text-sm font-medium">{view.headline}</p>
          <p className="text-xs text-muted-foreground">{detachedNote ?? view.detail}</p>
        </div>
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
       * tearing down its canvas. The thumbnail detaches while this is open, so
       * the handover is one socket for one human, not two.
       */}
      {view.canExpand && expanded && viewerPath !== null ? (
        <Dialog onOpenChange={setExpanded} open>
          <DialogPopup className="flex h-[90vh] w-[95vw] max-w-none flex-col gap-2 p-4">
            <DialogTitle className="text-sm font-semibold">{view.fullscreenTitle}</DialogTitle>
            <BotScreenViewer
              className="min-h-0 flex-1"
              frameClassName="min-h-0 flex-1"
              surfaceClassName="h-full w-full"
              viewerPath={viewerPath}
            />
          </DialogPopup>
        </Dialog>
      ) : null}
    </section>
  );
}
