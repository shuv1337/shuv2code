import type { AdeBotDetail, BotId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { AnchorIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { adeEnvironment, useAdeBotDetail, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage, adeCaptainErrorReason } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Textarea } from "../ui/textarea";
import {
  canSaveMemory,
  getBindingRowViews,
  getBotHeaderView,
  getPersonaVersionViews,
  PERSONA_EDIT_NOTE,
} from "./BotDetailPanel.logic";
import { BotScreenTab } from "./BotScreenTab";
import { DELETE_VOLUME_WORKAROUND_NOTE, deleteVolumeWorkaroundFor } from "./BotScreenTab.logic";

/**
 * One bot's captain-editable surface (spec §7 slice 2): bindings, memory,
 * persona history and the computer-use switch.
 */
export function BotDetailPanel({ botId }: { readonly botId: BotId }) {
  const detail = useAdeBotDetail(botId);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isElectron ? null : (
          <header
            className={cn(
              "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Bot breadcrumb">
              <WorkspaceBreadcrumbItem>
                <Link to="/fleet">Fleet</Link>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                {detail.data?.bot.name ?? "Bot"}
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
            {detail.error === null ? null : (
              <p className="text-sm text-destructive" role="alert">
                {detail.error}
              </p>
            )}
            {detail.data === null ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-40 w-full rounded-lg" />
              </div>
            ) : (
              <>
                <BotHeader botId={botId} detail={detail.data} />
                <BotDetailTabs botId={botId} detail={detail.data} />
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/**
 * Overview / Screen split.
 *
 * The Screen tab is deliberately **not** mounted until it is selected, and is
 * unmounted again when the captain leaves it. That is what ties the viewer's
 * lifetime to the tab: the proxy socket closes on unmount, which releases the
 * viewer hold that was keeping the desktop out of the idle sweep.
 */
function BotDetailTabs({
  botId,
  detail,
}: {
  readonly botId: BotId;
  readonly detail: AdeBotDetail;
}) {
  const [tab, setTab] = useState<"overview" | "screen">("overview");

  return (
    <>
      <div className="flex gap-1 border-b border-border" role="tablist">
        {(
          [
            ["overview", "Overview"],
            ["screen", "Screen"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-selected={tab === value}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              tab === value
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            role="tab"
            type="button"
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" ? (
        <>
          <BindingsTable detail={detail} />
          <MemoryEditor botId={botId} detail={detail} />
          <PersonaEditor botId={botId} detail={detail} />
          <DangerZone botId={botId} detail={detail} />
        </>
      ) : (
        <BotScreenTab botId={botId} />
      )}
    </>
  );
}

/**
 * Confirm-gated bot delete (spec §4.6).
 *
 * The confirmation names what is destroyed rather than asking a generic "are
 * you sure": deleting a bot also destroys its desktop without a snapshot, and
 * V1 has no snapshots to restore from.
 */
function DangerZone({ botId, detail }: { readonly botId: BotId; readonly detail: AdeBotDetail }) {
  const navigate = useNavigate();
  const environmentId = useAdeEnvironmentId();
  const deleteBot = useAtomCommand(adeEnvironment.deleteBot, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFirstmate = detail.bot.structuralRole === "firstmate";

  const handleDelete = async () => {
    if (environmentId === null) return;
    setError(null);
    setBusy(true);
    try {
      const result = await deleteBot({ environmentId, input: { botId } });
      if (result._tag === "Failure") {
        setError(
          adeCaptainErrorMessage(squashAtomCommandFailure(result), "The bot was not deleted."),
        );
        return;
      }
      setOpen(false);
      // The bot this route is keyed on no longer exists; staying here would
      // render a permanent "not found".
      void navigate({ to: "/fleet" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-destructive/40 px-4 py-3">
      <h2 className="text-sm font-semibold">Delete bot</h2>
      <p className="text-xs text-muted-foreground">
        {isFirstmate
          ? "The Firstmate is permanent and cannot be deleted."
          : "Removes this bot, its memory, persona history, bindings and assignments, and destroys its desktop. This cannot be undone."}
      </p>
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button
        className="self-start"
        disabled={isFirstmate}
        size="sm"
        variant="destructive"
        onClick={() => setOpen(true)}
      >
        Delete bot
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{detail.bot.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the bot and everything attached to it, and destroys its desktop without
              saving a snapshot. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1 px-1 text-xs text-muted-foreground">
            <p>{DELETE_VOLUME_WORKAROUND_NOTE}</p>
            <code className="rounded bg-muted px-2 py-1 font-mono text-[11px]">
              {deleteVolumeWorkaroundFor(botId)}
            </code>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button disabled={busy} variant="destructive" onClick={() => void handleDelete()}>
              {busy ? "Deleting…" : "Delete bot"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

function BotHeader({ botId, detail }: { readonly botId: BotId; readonly detail: AdeBotDetail }) {
  const environmentId = useAdeEnvironmentId();
  const view = getBotHeaderView(detail);
  const setComputerUse = useAtomCommand(adeEnvironment.setBotComputerUse, {
    reportFailure: false,
  });
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (next: boolean) => {
    if (environmentId === null) return;
    setError(null);
    const result = await setComputerUse({
      environmentId,
      input: { botId, computerUse: next },
    });
    if (result._tag === "Failure") {
      setError(
        adeCaptainErrorMessage(
          squashAtomCommandFailure(result),
          "Computer use could not be changed.",
        ),
      );
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {view.isFirstmate ? (
          <AnchorIcon aria-label="Firstmate" className="size-4 text-muted-foreground" />
        ) : null}
        <h1 className="truncate text-lg font-semibold">{view.name}</h1>
        <Badge size="sm" variant="outline">
          {view.roleLabel}
        </Badge>
        <Badge size="sm" variant="secondary">
          {view.roleTag}
        </Badge>
        <span className="truncate text-xs text-muted-foreground">{view.projectLabel}</span>
        <Button
          className="ml-auto shrink-0"
          render={<Link params={{ botId }} to="/fleet/$botId/chat" />}
          size="sm"
          variant="outline"
        >
          <MessageSquareIcon />
          Chat
        </Button>
      </div>
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>
          <span className="block font-medium">Computer use</span>
          <span className="text-xs text-muted-foreground">
            Lets this bot drive a Screenbox desktop.
          </span>
        </span>
        <Switch
          aria-label="Computer use"
          checked={view.computerUse}
          onCheckedChange={(next) => void handleToggle(Boolean(next))}
        />
      </label>
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function BindingsTable({ detail }: { readonly detail: AdeBotDetail }) {
  const rows = getBindingRowViews(detail.bindings);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Sessions</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No kernel session has ever been bound to this bot.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Engine</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.engine}</TableCell>
                  <TableCell>{row.purpose}</TableCell>
                  <TableCell>
                    <Badge size="sm" variant={row.statusVariant}>
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs">
                    {row.sessionId}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {row.updatedAt}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function MemoryEditor({ botId, detail }: { readonly botId: BotId; readonly detail: AdeBotDetail }) {
  const environmentId = useAdeEnvironmentId();
  const writeMemory = useAtomCommand(adeEnvironment.writeBotMemory, { reportFailure: false });
  const saved = detail.memory.content;
  const updatedAt = detail.memory.updatedAt;
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The panel re-reads after every write, and a conflict means the document on
  // screen is not the one the server holds. Adopting the server's copy is what
  // makes "reload" mean something the captain does not have to do by hand.
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState(updatedAt);
  useEffect(() => {
    if (updatedAt !== loadedUpdatedAt) {
      setLoadedUpdatedAt(updatedAt);
      setDraft(saved);
    }
  }, [loadedUpdatedAt, saved, updatedAt]);

  const handleSave = async () => {
    if (environmentId === null) return;
    setBusy(true);
    setError(null);
    const result = await writeMemory({
      environmentId,
      input: { botId, content: draft, expectedUpdatedAt: updatedAt },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const squashed = squashAtomCommandFailure(result);
      setError(
        adeCaptainErrorReason(squashed) === "memory_conflict"
          ? "Memory changed elsewhere — reload before saving."
          : adeCaptainErrorMessage(squashed, "Memory could not be saved."),
      );
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Memory</h2>
      <Textarea
        aria-label="Bot memory"
        className="min-h-40 font-mono text-xs"
        onChange={(event) => setDraft(event.target.value)}
        value={draft}
      />
      <div className="flex items-center gap-3">
        <Button
          disabled={!canSaveMemory({ draft, saved, busy })}
          onClick={() => void handleSave()}
          size="sm"
        >
          Save
        </Button>
        <span className="text-xs text-muted-foreground">Last written {updatedAt}</span>
      </div>
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function PersonaEditor({
  botId,
  detail,
}: {
  readonly botId: BotId;
  readonly detail: AdeBotDetail;
}) {
  const environmentId = useAdeEnvironmentId();
  const editPersona = useAtomCommand(adeEnvironment.editBotPersona, { reportFailure: false });
  const versions = getPersonaVersionViews(
    detail.personaVersions,
    detail.bot.activePersonaVersionId,
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (environmentId === null) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await editPersona({
      environmentId,
      input: { botId, content: draft.trim() },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        adeCaptainErrorMessage(
          squashAtomCommandFailure(result),
          "That persona could not be saved.",
        ),
      );
      return;
    }
    setDraft("");
    setSaved(true);
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Persona</h2>
      <Textarea
        aria-label="New persona"
        className="min-h-32 font-mono text-xs"
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Write a new persona version…"
        value={draft}
      />
      <div className="flex items-center gap-3">
        <Button
          disabled={busy || draft.trim().length === 0}
          onClick={() => void handleSave()}
          size="sm"
        >
          Save persona
        </Button>
        <span className="text-xs text-muted-foreground">{PERSONA_EDIT_NOTE}</span>
      </div>
      {saved ? (
        <p className="text-sm text-success-foreground" role="status">
          Saved. {PERSONA_EDIT_NOTE}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No persona has been written yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
            >
              <span className="flex items-center gap-2">
                <Badge
                  size="sm"
                  variant={version.stateLabel === "Active" ? "success" : "secondary"}
                >
                  {version.stateLabel}
                </Badge>
                <span className="text-xs text-muted-foreground">{version.createdAt}</span>
              </span>
              <p className="whitespace-pre-wrap text-xs text-foreground/90">{version.content}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
