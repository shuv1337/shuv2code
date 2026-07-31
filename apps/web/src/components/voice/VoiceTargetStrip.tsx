import type { RealtimeVoiceTarget } from "@shuv2code/client-runtime/state/realtime-voice";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";

export function VoiceTargetStrip({ target }: { readonly target: RealtimeVoiceTarget }) {
  return (
    <div className="border-border/60 border-t px-3 py-2 text-xs" data-voice-active-target>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {target.projectTitle ? `${target.projectTitle} · ` : ""}
            {target.threadTitle}
          </p>
          <p className="text-muted-foreground">
            {target.accepted ? "Accepted" : "Pending acceptance"}
            {" · "}
            {target.providerConfirmed ? "Provider confirmed" : "Awaiting provider"}
            {" · "}
            <span className="capitalize">{target.phase.replaceAll("-", " ")}</span>
          </p>
          {target.activeTurnId ? (
            <p className="truncate font-mono text-muted-foreground">Turn {target.activeTurnId}</p>
          ) : null}
        </div>
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: target.environmentId, threadId: target.threadId }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open <ExternalLinkIcon className="size-3" />
        </Link>
      </div>
    </div>
  );
}
