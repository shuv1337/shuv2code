import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import type { BotChatConnectNotice } from "./BotChatPage.logic";

/**
 * The two presentational pieces M8 (#217) needed in order to delete the
 * Start/Resume interstitial.
 *
 * The interstitial was a *landing page*: a greeting, a paragraph of kernel
 * setup, and a button, rendered instead of the conversation. Everything here is
 * rendered **over or inside the conversation shell** instead, so opening a bot
 * always looks like opening a conversation — connecting, degraded and live are
 * three states of one surface rather than two different screens.
 *
 * Both are pure props-in components with no thread, environment or store
 * access. That is deliberate: the web suite has no DOM, so `renderToStaticMarkup`
 * is the only way these states get a rendering test at all.
 */

/**
 * The compact inline notice.
 *
 * Primary copy is one product-voice sentence. Technical remediation — provider
 * instance ids, `shuvcode service start`, binary paths — is only ever reachable
 * through the collapsed disclosure, which is a native `<details>` so it needs no
 * client state and survives a static render.
 */
export function BotChatConnectNoticeStrip({
  notice,
  onRetry,
  retryLabel = "Retry",
  tone = "error",
}: {
  readonly notice: BotChatConnectNotice;
  /** Absent when the notice is informational and there is nothing to re-try. */
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly tone?: "error" | "muted";
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs",
        tone === "error"
          ? "bg-destructive/5 text-destructive"
          : "bg-muted/40 text-muted-foreground",
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="font-medium">{notice.message}</span>
      {onRetry === undefined ? null : (
        <Button className="h-6 px-2 text-xs" onClick={onRetry} size="sm" variant="outline">
          {retryLabel}
        </Button>
      )}
      {notice.details === null ? null : (
        <details className="w-full">
          <summary className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline">
            Details
          </summary>
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{notice.details}</p>
        </details>
      )}
    </div>
  );
}

/**
 * The conversation shell before a thread exists.
 *
 * Shaped like the real conversation — message region above, composer below — so
 * connecting reads as the conversation arriving rather than as a different
 * screen. The composer is a disabled stand-in rather than the real
 * `CaptainComposer`: the real one is scoped to a thread, and mounting it (or
 * the timeline) against a thread the client store has never seen is exactly the
 * hook-count crash #197 fixed. Nothing here is a `ChatView`/`BubbleTimeline`
 * ancestor, so that gate is untouched.
 *
 * `shimmer` is off in the failed state — an animation that never resolves reads
 * as "still trying" next to a notice that says it stopped.
 */
export function BotChatPendingConversation({
  botName,
  shimmer,
}: {
  readonly botName: string;
  readonly shimmer: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div aria-hidden className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-5 py-4">
        {shimmer ? (
          <>
            <div className="h-8 w-40 self-start rounded-2xl bg-muted/60 motion-safe:animate-pulse" />
            <div className="h-8 w-28 self-end rounded-2xl bg-muted/40 motion-safe:animate-pulse" />
          </>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <div
          aria-disabled
          className="flex h-10 items-center rounded-xl border border-border bg-muted/30 px-3 text-sm text-placeholder"
        >
          {`Message ${botName}`}
        </div>
      </div>
    </div>
  );
}
