import type { BotId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { MonitorIcon } from "lucide-react";
import { useState } from "react";

import { adeEnvironment, useAdeBotScreen, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { getBotScreenView } from "./BotScreenTab.logic";
import { BotScreenViewer } from "./BotScreenViewer";

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
        <BotScreenViewer viewerPath={view.viewerPath} />
      )}
    </section>
  );
}
