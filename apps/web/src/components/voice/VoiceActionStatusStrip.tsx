import type { RealtimeVoiceControllerAction } from "@shuv2code/client-runtime/state/realtime-voice";
import { CheckCircle2Icon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";

const activeStates = new Set(["queued", "controller-starting", "controller-working"]);
const failureStates = new Set(["failed", "stale", "indeterminate"]);

function actionLabel(state: RealtimeVoiceControllerAction["state"]): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "controller-starting":
      return "Starting";
    case "controller-working":
      return "Working";
    case "accepted":
      return "Accepted";
    case "provider-confirmed":
      return "Provider confirmed";
    case "completed":
      return "Finished";
    case "failed":
      return "Failed";
    case "stale":
      return "No longer current";
    case "indeterminate":
      return "Needs attention";
    case "superseded":
      return "Replaced";
  }
}

export function VoiceActionStatusStrip({
  action,
}: {
  readonly action: RealtimeVoiceControllerAction;
}) {
  const active = activeStates.has(action.state);
  const failed = failureStates.has(action.state);
  return (
    <div
      className={
        failed
          ? "flex items-start gap-2 border-border/60 border-b bg-destructive/5 px-3 py-2 text-destructive-foreground"
          : "flex items-start gap-2 border-border/60 border-b bg-muted/20 px-3 py-2"
      }
      data-voice-action-status={action.state}
      aria-live="polite"
      aria-atomic="true"
    >
      {active ? (
        <LoaderCircleIcon
          className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      ) : failed ? (
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="text-xs font-semibold">{actionLabel(action.state)}</p>
        <p className={failed ? "text-xs" : "text-xs text-muted-foreground"}>{action.statusText}</p>
      </div>
    </div>
  );
}
