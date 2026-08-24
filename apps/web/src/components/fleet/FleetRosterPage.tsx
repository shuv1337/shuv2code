import type { AdeBotTemplateId, AdeProjectId, EnvironmentId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { AnchorIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { adeEnvironment, useAdeEnvironmentId, useAdeRoster } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import {
  getRosterRowViews,
  rosterNeedsFirstProject,
  templateOptionLabel,
} from "./FleetRosterPage.logic";

/** Sentinel for "no home project" — a fleet-shared specialist. */
const NO_PROJECT = "__none__";

/**
 * The captain's crew list (spec §7 slice 2). The Firstmate is pinned by the
 * server's own ordering; this page only marks it. Nothing here starts a kernel
 * session — chat is opened lazily on its own route (spec §4.1).
 */
export function FleetRosterPage() {
  const environmentId = useAdeEnvironmentId();
  const roster = useAdeRoster();
  const rows = getRosterRowViews(roster.data);
  const needsFirstProject = rosterNeedsFirstProject(roster.data);

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
            <WorkspaceBreadcrumb ariaLabel="Fleet breadcrumb">
              <WorkspaceBreadcrumbItem current>Fleet</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
            {needsFirstProject ? <FirstProjectCta environmentId={environmentId} /> : null}
            <AddFromTemplateControl
              environmentId={environmentId}
              projects={roster.data?.projects ?? []}
              templates={roster.data?.templates ?? []}
            />
            {roster.error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {roster.error}
              </p>
            )}
            {roster.data === null && roster.isPending ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>
            ) : rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No bots yet</EmptyTitle>
                  <EmptyDescription>
                    Add one from a template above to start building your crew.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <li
                    key={row.botId}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-sidebar-row-hover"
                  >
                    <Link
                      className="flex min-w-0 flex-1 flex-col gap-1 outline-hidden"
                      params={{ botId: row.botId }}
                      to="/fleet/$botId"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        {row.isFirstmate ? (
                          <AnchorIcon
                            aria-label="Firstmate"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                        <span className="truncate text-sm font-medium">{row.name}</span>
                        <Badge size="sm" variant="secondary">
                          {row.roleTag}
                        </Badge>
                        {row.isFirstmate ? (
                          <Badge size="sm" variant="outline">
                            {row.roleLabel}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{row.projectLabel}</span>
                        {row.openAssignmentLabel === null ? null : (
                          <span className="truncate">· {row.openAssignmentLabel}</span>
                        )}
                      </span>
                    </Link>
                    <Button
                      className="shrink-0"
                      render={<Link params={{ botId: row.botId }} to="/fleet/$botId/chat" />}
                      size="sm"
                      variant="outline"
                    >
                      <MessageSquareIcon />
                      {row.chatLabel}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** Issue #141: point at the existing project surface rather than a new wizard. */
/**
 * The empty-state CTA (#141). It creates an **ADE** project — the thing that
 * owns a crew and auto-creates a Second Mate — not a shuv2code workspace
 * project. Pointing this at the generic workspace palette left the fleet with
 * no ADE projects at all: the Project combobox below stayed permanently empty,
 * every bot was fleet-wide, and the auto-Second-Mate hook was unreachable.
 */
function FirstProjectCta({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const createProject = useAtomCommand(adeEnvironment.createProject, { reportFailure: false });
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (environmentId === null || name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await createProject({
      environmentId,
      input: {
        name: name.trim(),
        repoPath: repoPath.trim().length === 0 ? null : repoPath.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        adeCaptainErrorMessage(
          squashAtomCommandFailure(result),
          "The project could not be created.",
        ),
      );
      return;
    }
    setName("");
    setRepoPath("");
  };

  return (
    <Empty className="rounded-lg border border-border">
      <EmptyHeader>
        <EmptyTitle>Create your first project</EmptyTitle>
        <EmptyDescription>
          Bots do their work inside a project. Creating one also creates its Second Mate.
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex w-full max-w-md flex-col gap-2">
        <Input
          aria-label="Project name"
          onChange={(event) => setName(event.target.value)}
          placeholder="Project name"
          value={name}
        />
        <Input
          aria-label="Repository path"
          onChange={(event) => setRepoPath(event.target.value)}
          placeholder="Repository path (optional)"
          value={repoPath}
        />
        <Button
          className="self-start"
          disabled={busy || environmentId === null || name.trim().length === 0}
          onClick={() => void submit()}
          size="sm"
        >
          <PlusIcon />
          Create project
        </Button>
        {error === null ? null : (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </Empty>
  );
}

function AddFromTemplateControl({
  environmentId,
  projects,
  templates,
}: {
  readonly environmentId: ReturnType<typeof useAdeEnvironmentId>;
  readonly projects: ReadonlyArray<{ readonly id: AdeProjectId; readonly name: string }>;
  readonly templates: ReadonlyArray<{
    readonly templateId: AdeBotTemplateId;
    readonly defaultName: string;
    readonly roleTag: string;
  }>;
}) {
  const createBot = useAtomCommand(adeEnvironment.createBotFromTemplate, {
    reportFailure: false,
  });
  const [templateId, setTemplateId] = useState<AdeBotTemplateId | null>(null);
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = templates.find((template) => template.templateId === templateId) ?? null;
  const canAdd = environmentId !== null && selected !== null && !busy;

  const handleAdd = async () => {
    if (environmentId === null || selected === null) return;
    setBusy(true);
    setError(null);
    const trimmed = name.trim();
    const result = await createBot({
      environmentId,
      input: {
        templateId: selected.templateId,
        projectId: projectId === NO_PROJECT ? null : (projectId as AdeProjectId),
        ...(trimmed.length === 0 ? {} : { name: trimmed }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      // A refused template is a real answer, not a silent no-op: it stays on
      // screen until the captain changes the request.
      setError(
        adeCaptainErrorMessage(
          squashAtomCommandFailure(result),
          "That bot could not be added right now.",
        ),
      );
      return;
    }
    setName("");
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
      <span className="text-sm font-medium">Add from template</span>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={templateId ?? ""}
          onValueChange={(value) => setTemplateId((value as AdeBotTemplateId) || null)}
        >
          <SelectTrigger aria-label="Template" className="w-48">
            <SelectValue>
              {selected === null ? "Choose a template" : selected.defaultName}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {templates.map((template) => (
              <SelectItem hideIndicator key={template.templateId} value={template.templateId}>
                {templateOptionLabel(template)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select value={projectId} onValueChange={(value) => setProjectId(String(value))}>
          <SelectTrigger aria-label="Project" className="w-48">
            <SelectValue>
              {projects.find((project) => project.id === projectId)?.name ?? "No project"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={NO_PROJECT}>
              No project
            </SelectItem>
            {projects.map((project) => (
              <SelectItem hideIndicator key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          aria-label="Name override"
          className="w-48"
          onChange={(event) => setName(event.target.value)}
          placeholder={selected?.defaultName ?? "Name (optional)"}
          value={name}
        />
        <Button disabled={!canAdd} onClick={() => void handleAdd()} size="sm">
          <PlusIcon />
          Add
        </Button>
      </div>
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
