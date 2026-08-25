import type { EnvironmentProject } from "@shuv2code/client-runtime/state/shell";
import type { BotId, ProjectAutomationSummary, ScopedProjectRef } from "@shuv2code/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAdeBotRoutineContext, useAdeEnvironmentId } from "../../state/ade";
import { automationEnvironment } from "../../state/automations";
import { useProject } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { AutomationEditor, useAutomationEditorModelContext } from "../settings/AutomationsSettings";
import {
  emptyAutomationFormValue,
  mergeAutomationSummaryPages,
  parseAutomationFormValue,
  upsertAutomationSummary,
  type AutomationFormValue,
} from "../settings/AutomationsSettings.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import {
  ROUTINES_PENDING_PROJECT,
  canCreateRoutine,
  getRoutineRowViews,
  routinesEmptyState,
  routinesSummaryLabel,
} from "./routinesPanel.logic";

/**
 * The right rail's Routines section (MESSENGER-PIVOT §2/§4, M6).
 *
 * Routines are not a new mechanism: they are `project_automations` rows on the
 * existing scheduler, created through the *same* `AutomationEditor` that
 * Settings → Automations mounts and listed through the same `automations.list`
 * RPC. The only ADE-specific parts are the `ade_bot_id` attribution (migration
 * 060) and `ade.getBotRoutineContext`, which answers the one question the rail
 * cannot answer for itself: which workspace project this bot's routines belong
 * to, and — when the answer is none — which of the three possible remedies to
 * name.
 */
export function RoutinesPanel({
  botId,
  botName,
}: {
  readonly botId: BotId;
  readonly botName: string;
}) {
  const environmentId = useAdeEnvironmentId();
  const context = useAdeBotRoutineContext(botId);
  const [creating, setCreating] = useState(false);

  const projectId = context.data?.projectId ?? null;
  const projectRef: ScopedProjectRef | null =
    environmentId === null || projectId === null ? null : { environmentId, projectId };
  /*
   * Resolved here, above the branch, so the header's Create button and the
   * form below it are gated on the *same* facts. Previously the button asked
   * the RPC and the form asked the orchestration shell, and when those two
   * disagreed the button enabled and rendered nothing (D4). `useProject`
   * accepts a null ref, so this stays a plain unconditional hook.
   */
  const project = useProject(projectRef);

  if (context.data === null) {
    return (
      <section aria-label="Routines" className="flex flex-col gap-2 p-3">
        <Skeleton className="h-24 w-full rounded-lg" />
      </section>
    );
  }

  const empty = routinesEmptyState(context.data);
  const canCreate = canCreateRoutine(context.data, project !== null);
  // Resolved by the server but not yet by the shell: not an empty state, since
  // there is nothing for the captain to fix.
  const pending = empty === null && project === null ? ROUTINES_PENDING_PROJECT : null;
  const notice = empty ?? pending;

  return (
    <section aria-label="Routines" className="flex min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <CalendarClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="truncate text-sm font-semibold">Routines</h2>
        {canCreate && !creating ? (
          <Button className="ms-auto" onClick={() => setCreating(true)} size="sm" variant="outline">
            <PlusIcon aria-hidden />
            Create Routine
          </Button>
        ) : null}
      </div>

      {context.error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {context.error}
        </p>
      )}

      {notice !== null || projectRef === null || project === null ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-3">
          <p className="text-sm font-medium">{notice?.headline ?? "Routines unavailable"}</p>
          {/*
           * A loading notice has a state but no next action, so its detail is
           * empty and the line is simply not drawn — an empty `<p>` reserving
           * space under a headline reads as copy that failed to load.
           */}
          {(notice?.detail ?? "Check this bot's project.").length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              {notice?.detail ?? "Check this bot's project."}
            </p>
          )}
          {/*
           * If the project vanished after Create was pressed — the shell
           * re-snapshotting under a captain mid-form — say so and offer the way
           * out. Rendering nothing here is the exact shape of D4: a pressed
           * button with no visible consequence.
           */}
          {creating ? (
            <Button onClick={() => setCreating(false)} size="sm" variant="ghost">
              Cancel
            </Button>
          ) : null}
        </div>
      ) : (
        <RoutinesList
          botId={botId}
          botName={botName}
          creating={creating}
          onCreatingChange={setCreating}
          project={project}
          projectRef={projectRef}
        />
      )}
    </section>
  );
}

function asyncError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (!AsyncResult.isFailure(result)) return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error && cause.message.trim() ? cause.message : String(cause);
}

/**
 * Split from `RoutinesPanel` because the automations query needs a resolved
 * project ref and React hooks cannot be conditional. Keeping it behind a
 * component boundary means the panel reads no automations at all for a bot that
 * has no project — the empty state costs one RPC, not three.
 */
function RoutinesList({
  botId,
  botName,
  project,
  projectRef,
  creating,
  onCreatingChange,
}: {
  readonly botId: BotId;
  readonly botName: string;
  /** Already resolved by the panel, which gates the Create button on it. */
  readonly project: EnvironmentProject;
  readonly projectRef: ScopedProjectRef;
  readonly creating: boolean;
  readonly onCreatingChange: (next: boolean) => void;
}) {
  const result = useAtomValue(
    automationEnvironment.list({
      environmentId: projectRef.environmentId,
      // The bot filter is served in SQL (migration 060's index), so the rail
      // never pages through a project's whole automation list to find three
      // rows.
      input: { projectId: projectRef.projectId, botId },
    }),
  );
  const createAutomation = useAtomCommand(automationEnvironment.create, { reportFailure: false });
  const [created, setCreated] = useState<ReadonlyArray<ProjectAutomationSummary>>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const data = Option.getOrNull(AsyncResult.value(result));
  const queryError = asyncError(result);
  const automations = useMemo(
    () => mergeAutomationSummaryPages(data?.automations ?? [], created),
    [created, data?.automations],
  );
  const rows = useMemo(() => getRoutineRowViews({ automations, botId }), [automations, botId]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground">{routinesSummaryLabel(rows)}</p>
      {queryError === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {queryError}
        </p>
      )}
      {saveError === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li
            className="flex items-start gap-2 rounded-lg border border-border bg-background p-2"
            key={row.id}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{row.name}</span>
                {row.scopeLabel === null ? null : (
                  <Badge size="sm" variant="secondary">
                    {row.scopeLabel}
                  </Badge>
                )}
              </span>
              <span className="truncate text-xs text-muted-foreground">{row.schedule}</span>
            </span>
            {/*
             * Read-only on the rail. Enabling a schedule is a decision with a
             * bill attached, and this panel deliberately has no error surface
             * next to each row — Settings → Automations owns editing, running
             * now, and history.
             */}
            <Switch aria-label={`${row.name} enabled`} checked={row.enabled} disabled />
          </li>
        ))}
      </ul>

      {creating ? (
        <RoutineCreateForm
          botId={botId}
          botName={botName}
          busy={busy}
          onCancel={() => {
            onCreatingChange(false);
            setSaveError(null);
          }}
          onSubmit={async (value) => {
            const parsed = parseAutomationFormValue(value);
            if (!parsed.ok) {
              setSaveError(parsed.error);
              return;
            }
            setSaveError(null);
            setBusy(true);
            const outcome = await createAutomation({
              environmentId: project.environmentId,
              input: { projectId: project.id, botId, ...parsed.value },
            });
            setBusy(false);
            if (!AsyncResult.isSuccess(outcome)) {
              setSaveError(asyncError(outcome) ?? "The routine could not be created.");
              return;
            }
            // Show it immediately rather than waiting for the list's poll: the
            // captain just typed it, and a row that takes five seconds to
            // appear reads as a failure.
            setCreated((current) => upsertAutomationSummary(current, outcome.value));
            onCreatingChange(false);
          }}
          project={project}
        />
      ) : null}
    </div>
  );
}

function RoutineCreateForm({
  project,
  botName,
  busy,
  onCancel,
  onSubmit,
}: {
  readonly project: EnvironmentProject;
  readonly botId: BotId;
  readonly botName: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (value: AutomationFormValue) => Promise<void>;
}) {
  const { fallbackModelSelection, instanceEntries, modelOptionsByInstance } =
    useAutomationEditorModelContext(project, null);
  const initial = useMemo(
    () => ({
      ...emptyAutomationFormValue(fallbackModelSelection),
      name: `${botName} routine`,
    }),
    [botName, fallbackModelSelection],
  );
  return (
    <div className="rounded-lg border border-border p-2">
      <AutomationEditor
        busy={busy}
        initial={initial}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        onCancel={onCancel}
        onSave={onSubmit}
        project={project}
      />
    </div>
  );
}
