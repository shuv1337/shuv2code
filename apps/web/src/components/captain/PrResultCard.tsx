import type { PublicationStackId } from "@shuv2code/contracts";
import { GitPullRequestIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useAdePublicationStack } from "../../state/ade";
import {
  getPublicationStackView,
  type PublicationLayerRowView,
} from "../fleet/ProjectViewPage.logic";
import { AssignmentResultCard } from "../fleet/AssignmentResultCard";
import type { ParsedAssignmentDelivery } from "../fleet/assignmentResult.logic";
import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { ARTIFACT_HOVER_GROUP_CLASS, ArtifactHoverActions } from "./ArtifactHoverActions";
import { CaptainExternalLink } from "./CaptainExternalLink";
import { resolveDeliveryStatus, resolvePrResultArtifacts } from "./richCards.logic";

const DELIVERY_STATUS_TONE = {
  completed: "success",
  failed: "error",
  cancelled: "secondary",
} as const;

const DELIVERY_STATUS_LABEL = {
  completed: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

/**
 * The work/PR card (MESSENGER-PIVOT §3, §6 M5).
 *
 * A finished assignment that produced a publication is the captain's single
 * most consequential card: it is the one that ends in "should this land?".
 * `AssignmentResultCard` already renders what the bot *said*; this adds what the
 * bot *made* — the publication stack's layers, each with its branch, PR
 * reference, and state — and a way out to the PR.
 *
 * ## Why the stack is fetched by id
 * The delivery's `publicationLayer` artifact carries `{stackId, layerId}` and no
 * project id, so the project-keyed read cannot serve this card: it answers with
 * whichever stack is newest for a project, which is the wrong stack the moment a
 * project publishes twice. `ade.getPublicationStack` is the read that closes
 * that gap; `useAdePublicationStack(null)` starts no poller, so a delivery with
 * no stack costs nothing.
 *
 * ## Why the diff summary is usually absent
 * This is the captain's route to a diff, and it is a *reference*, not a
 * rendering: `onOpenTurnDiff` is a workspace callback `CaptainRowHost` stubs to
 * a no-op, so there is no diff panel to open here. Nor is there a per-layer
 * stat to show — `PublicationLayer` carries SHAs and change ids, and no
 * contract on this path carries additions/deletions. A stat therefore appears
 * only when the captain's *own* thread produced the turn behind the card, which
 * delegated work never does; the layer's SHA is shown instead, which is the
 * honest handle. Inventing a number here would be worse than omitting one.
 */
export function PrResultCard({
  delivery,
  diffStat,
  className,
}: {
  readonly delivery: ParsedAssignmentDelivery;
  /** The turn's changed-line totals, when this thread produced them. */
  readonly diffStat?: { readonly additions: number; readonly deletions: number } | null;
  readonly className?: string;
}) {
  const artifacts = resolvePrResultArtifacts(delivery);
  // Layers are addressed per stack; a batch that published into two stacks is
  // possible in principle, and taking the first keeps the card to one subject
  // rather than fanning a conversation card into N pollers.
  const stackId = (artifacts.layers[0]?.stackId ?? null) as PublicationStackId | null;
  const query = useAdePublicationStack(stackId);
  const stack = getPublicationStackView(query.data);
  const status = resolveDeliveryStatus(delivery);

  // Only the layers this delivery actually claims. A stack accumulates layers
  // from every assignment that published into it, and showing all of them would
  // credit this bot with work it did not do.
  const claimedLayerIds = new Set(artifacts.layers.map((layer) => layer.layerId));
  const layers = (stack?.layers ?? []).filter((layer) => claimedLayerIds.has(layer.layerId));

  const primaryUrl = artifacts.urls[0]?.href ?? stack?.stackUrl ?? null;

  return (
    <div className="flex w-full justify-start py-1">
      <article
        className={cn(
          ARTIFACT_HOVER_GROUP_CLASS,
          "min-w-0 max-w-[min(90%,38rem)] rounded-2xl rounded-bl-md border border-border/60 bg-muted/30",
          className,
        )}
        data-pr-result-stack-id={stackId ?? undefined}
      >
        <header className="flex items-center gap-2 px-3 pt-2.5">
          <GitPullRequestIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <Badge size="sm" variant={DELIVERY_STATUS_TONE[status]}>
            {DELIVERY_STATUS_LABEL[status]}
          </Badge>
          {stack === null ? null : (
            <Badge size="sm" variant={stack.statusTone}>
              {stack.statusLabel}
            </Badge>
          )}
          {diffStat != null && hasNonZeroStat(diffStat) ? (
            <DiffStatLabel
              additions={diffStat.additions}
              className="text-[11px]"
              deletions={diffStat.deletions}
              layout="inline"
            />
          ) : null}
          <div className="flex-1" />
          <ArtifactHoverActions
            copyLabel={primaryUrl === null ? "Copy branch" : "Copy link"}
            copyText={primaryUrl ?? layers[0]?.bookmarkName}
            openHref={primaryUrl ?? undefined}
            openLabel="View PR"
          />
        </header>

        <div className="px-3 py-2">
          <AssignmentResultCard delivery={delivery} variant="nested" />
        </div>

        <section aria-label="Publication" className="border-t border-border/60 px-3 py-2">
          {stackId !== null && stack === null && query.isPending ? (
            <Skeleton className="h-6 w-full rounded-md" />
          ) : layers.length === 0 ? (
            // The artifact named a stack the read could not produce — retired,
            // or a layer this delivery claims that the stack no longer holds.
            // The bot's own account above is still the truth of what happened.
            <p className="text-xs text-muted-foreground">
              {stackId === null
                ? "No publication stack was reported."
                : "This publication is no longer on the stack."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {layers.map((layer) => (
                <PrResultLayerRow key={layer.layerId} layer={layer} url={primaryUrl} />
              ))}
            </ul>
          )}
        </section>
      </article>
    </div>
  );
}

function PrResultLayerRow({
  layer,
  url,
}: {
  readonly layer: PublicationLayerRowView;
  readonly url: string | null;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      <span className="shrink-0 font-medium tabular-nums text-muted-foreground">
        {layer.orderLabel}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono" title={layer.bookmarkName}>
        {layer.bookmarkName}
      </span>
      {url === null ? (
        <Badge size="sm" variant={layer.prTone}>
          {layer.prLabel}
          {layer.prState === null ? "" : ` · ${layer.prState}`}
        </Badge>
      ) : (
        <CaptainExternalLink href={url}>
          <Badge size="sm" variant={layer.prTone}>
            {layer.prLabel}
            {layer.prState === null ? "" : ` · ${layer.prState}`}
          </Badge>
        </CaptainExternalLink>
      )}
      <span className="shrink-0 truncate font-mono text-muted-foreground">
        {layer.shaLabel ?? layer.statusLabel}
      </span>
    </li>
  );
}
