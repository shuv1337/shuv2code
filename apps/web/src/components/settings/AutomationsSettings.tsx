import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@shuv2code/client-runtime/state/shell";
import {
  type ModelSelection,
  type ProjectAutomation,
  type RuntimeMode,
  type ProviderInteractionMode,
  type AutomationConcurrencyPolicy,
  type AutomationRun,
} from "@shuv2code/contracts";
import { createModelSelection } from "@shuv2code/shared/model";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  CopyIcon,
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useProjects } from "../../state/entities";
import { automationEnvironment } from "../../state/automations";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  parseAutomationScheduleFields,
  parseAutomationTextFields,
} from "./AutomationsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type AutomationFormValue = {
  readonly name: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly concurrencyPolicy: AutomationConcurrencyPolicy;
};

const DEFAULT_CRON = "0 9 * * 1-5";

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatDateTime(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatRelative(value: string | null): string {
  if (value === null) return "Never";
  const delta = new Date(value).getTime() - Date.now();
  const absoluteMinutes = Math.round(Math.abs(delta) / 60_000);
  if (absoluteMinutes < 1) return delta >= 0 ? "in under a minute" : "just now";
  if (absoluteMinutes < 60)
    return delta >= 0 ? `in ${absoluteMinutes}m` : `${absoluteMinutes}m ago`;
  const hours = Math.round(absoluteMinutes / 60);
  if (hours < 48) return delta >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return delta >= 0 ? `in ${days}d` : `${days}d ago`;
}

function formatModelOption(id: string, value: string | boolean): string {
  const label = id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
  const renderedValue = typeof value === "boolean" ? (value ? "On" : "Off") : value;
  return `${label}: ${renderedValue}`;
}

function asyncError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (!AsyncResult.isFailure(result)) return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error && cause.message.trim() ? cause.message : String(cause);
}

function AutomationHistory({
  automation,
  project,
}: {
  readonly automation: ProjectAutomation;
  readonly project: EnvironmentProject;
}) {
  const navigate = useNavigate();
  const result = useAtomValue(
    automationEnvironment.runs({
      environmentId: project.environmentId,
      input: { projectId: project.id, automationId: automation.id, limit: 50 },
    }),
  );
  const data = Option.getOrNull(AsyncResult.value(result));
  const error = asyncError(result);

  if (result.waiting && data === null) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Spinner /> Loading run history…
      </div>
    );
  }
  if (error !== null && data === null) {
    return <p className="py-3 text-sm text-destructive">{error}</p>;
  }
  if (!data || data.runs.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="divide-y divide-border/60">
      {data.runs.map((run: AutomationRun) => (
        <div
          key={run.id}
          className="grid gap-2 py-3 text-sm sm:grid-cols-[9rem_1fr_auto] sm:items-center"
        >
          <div className="flex items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-xs capitalize text-muted-foreground">{run.trigger}</span>
          </div>
          <div className="min-w-0">
            <p className="truncate text-foreground/90">{formatDateTime(run.scheduledFor)}</p>
            {run.error ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-destructive">{run.error}</p>
            ) : null}
          </div>
          {run.threadId ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: project.environmentId, threadId: run.threadId! },
                })
              }
            >
              Open thread
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RunStatusBadge({ status }: { readonly status: AutomationRun["status"] }) {
  const variant =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "error"
        : status === "skipped"
          ? "warning"
          : "info";
  return <Badge variant={variant}>{status}</Badge>;
}

function AutomationEditor({
  initial,
  project,
  instanceEntries,
  modelOptionsByInstance,
  onCancel,
  onSave,
  busy,
}: {
  readonly initial: AutomationFormValue;
  readonly project: EnvironmentProject;
  readonly instanceEntries: ReturnType<typeof sortProviderInstanceEntries>;
  readonly modelOptionsByInstance: ReturnType<typeof getCustomModelOptionsByInstance>;
  readonly onCancel: () => void;
  readonly onSave: (value: AutomationFormValue) => Promise<void>;
  readonly busy: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [validation, setValidation] = useState<{ message: string; valid: boolean } | null>(null);
  const [validating, setValidating] = useState(false);
  const validateSchedule = useAtomCommand(automationEnvironment.validateSchedule);
  const activeInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === value.modelSelection.instanceId,
  );

  const runValidation = async () => {
    const parsed = parseAutomationScheduleFields(value.cronExpression, value.timeZone);
    if (!parsed.ok) {
      setValidation({ valid: false, message: parsed.error });
      return false;
    }
    setValidating(true);
    try {
      const result = await validateSchedule({
        environmentId: project.environmentId,
        input: parsed.value,
      });
      if (AsyncResult.isSuccess(result)) {
        setValidation({
          valid: result.value.valid,
          message: result.value.valid
            ? `Next run: ${formatDateTime(result.value.nextRunAt)}`
            : (result.value.error ?? "Invalid schedule."),
        });
        return result.value.valid;
      }
      setValidation({
        valid: false,
        message: asyncError(result) ?? "Could not validate schedule.",
      });
      return false;
    } catch (cause) {
      setValidation({
        valid: false,
        message: cause instanceof Error ? cause.message : "Could not validate schedule.",
      });
      return false;
    } finally {
      setValidating(false);
    }
  };

  return (
    <Card className="overflow-hidden border-primary/25 bg-primary/[0.025]">
      <div className="border-b px-4 py-4 sm:px-5">
        <h3 className="font-semibold">
          {initial.name ? `Edit ${initial.name}` : "New automation"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Runs as a new project thread using the selected model and permissions.
        </p>
      </div>
      <div className="grid gap-5 px-4 py-5 sm:px-5">
        <label className="grid gap-1.5 text-sm font-medium">
          Name
          <Input
            aria-label="Automation name"
            value={value.name}
            onValueChange={(name) => setValue((current) => ({ ...current, name }))}
            placeholder="Instagram morning report"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Instructions
          <Textarea
            aria-label="Automation instructions"
            value={value.prompt}
            onChange={(event) =>
              setValue((current) => ({ ...current, prompt: event.target.value }))
            }
            rows={9}
            placeholder="Describe the complete unattended task, its output, and its completion gates."
          />
          <span className="font-normal text-xs text-muted-foreground">
            The prompt is sent verbatim as the first message in every scheduled thread.
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Cron schedule
            <Input
              aria-label="Cron schedule"
              value={value.cronExpression}
              onValueChange={(cronExpression) => {
                setValue((current) => ({ ...current, cronExpression }));
                setValidation(null);
              }}
              placeholder={DEFAULT_CRON}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Time zone
            <Input
              aria-label="Time zone"
              value={value.timeZone}
              onValueChange={(timeZone) => {
                setValue((current) => ({ ...current, timeZone }));
                setValidation(null);
              }}
              placeholder="Europe/London"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={validating}
            onClick={() => void runValidation()}
          >
            {validating ? <Spinner /> : <Clock3Icon />} Validate schedule
          </Button>
          {validation ? (
            <span
              className={
                validation.valid ? "text-xs text-success-foreground" : "text-xs text-destructive"
              }
            >
              {validation.message}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Example: <code>{DEFAULT_CRON}</code> means 09:00, Monday–Friday.
            </span>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5 text-sm font-medium">
            Model
            {instanceEntries.length > 0 ? (
              <div className="flex min-w-0 flex-wrap gap-2">
                <ProviderModelPicker
                  activeInstanceId={value.modelSelection.instanceId}
                  model={value.modelSelection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none flex-1 justify-between"
                  triggerAriaLabel="Automation model"
                  onInstanceModelChange={(instanceId, model) =>
                    setValue((current) => ({
                      ...current,
                      modelSelection: createModelSelection(instanceId, model),
                    }))
                  }
                />
                {activeInstanceEntry ? (
                  <TraitsPicker
                    provider={activeInstanceEntry.driverKind}
                    instanceId={activeInstanceEntry.instanceId}
                    models={activeInstanceEntry.models}
                    model={value.modelSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={value.modelSelection.options}
                    allowPromptInjectedEffort={false}
                    triggerVariant="outline"
                    triggerClassName="shrink-0"
                    onModelOptionsChange={(options) =>
                      setValue((current) => ({
                        ...current,
                        modelSelection: createModelSelection(
                          current.modelSelection.instanceId,
                          current.modelSelection.model,
                          options,
                        ),
                      }))
                    }
                  />
                ) : null}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={value.modelSelection.instanceId}
                  disabled
                  aria-label="Provider instance"
                />
                <Input value={value.modelSelection.model} disabled aria-label="Model" />
              </div>
            )}
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Permissions
            <Select
              value={value.runtimeMode}
              onValueChange={(runtimeMode) =>
                setValue((current) => ({ ...current, runtimeMode: runtimeMode as RuntimeMode }))
              }
            >
              <SelectTrigger aria-label="Automation permissions">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="full-access">Full access</SelectItem>
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="auto-accept-edits">Auto-accept edits</SelectItem>
                <SelectItem value="approval-required">Approval required</SelectItem>
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Agent mode
            <Select
              value={value.interactionMode}
              onValueChange={(interactionMode) =>
                setValue((current) => ({
                  ...current,
                  interactionMode: interactionMode as ProviderInteractionMode,
                }))
              }
            >
              <SelectTrigger aria-label="Automation agent mode">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="plan">Plan</SelectItem>
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            If a previous run is active
            <Select
              value={value.concurrencyPolicy}
              onValueChange={(concurrencyPolicy) =>
                setValue((current) => ({
                  ...current,
                  concurrencyPolicy: concurrencyPolicy as AutomationConcurrencyPolicy,
                }))
              }
            >
              <SelectTrigger aria-label="Automation overlap policy">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="skip">Skip the new run</SelectItem>
                <SelectItem value="parallel">Run in parallel</SelectItem>
              </SelectPopup>
            </Select>
          </label>
        </div>

        <label className="flex items-center justify-between gap-4 rounded-xl border bg-background/60 px-3 py-3 text-sm">
          <span>
            <span className="block font-medium">Enabled</span>
            <span className="text-xs text-muted-foreground">
              Disabled automations retain their configuration and history.
            </span>
          </span>
          <Switch
            aria-label="Automation enabled"
            checked={value.enabled}
            onCheckedChange={(enabled) =>
              setValue((current) => ({ ...current, enabled: Boolean(enabled) }))
            }
          />
        </label>
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/30 px-4 py-4 sm:px-5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={busy || !value.name.trim() || !value.prompt.trim()}
          onClick={() =>
            void (async () => {
              const valid = validation?.valid === true ? true : await runValidation();
              if (valid) await onSave(value);
            })()
          }
        >
          {busy ? <Spinner /> : null} Save automation
        </Button>
      </div>
    </Card>
  );
}

function AutomationProjectPanel({ project }: { readonly project: EnvironmentProject }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const settings = useEnvironmentSettings(project.environmentId);
  const result = useAtomValue(
    automationEnvironment.list({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const createAutomation = useAtomCommand(automationEnvironment.create);
  const updateAutomation = useAtomCommand(automationEnvironment.update);
  const deleteAutomation = useAtomCommand(automationEnvironment.delete);
  const runNow = useAtomCommand(automationEnvironment.runNow);
  const [editing, setEditing] = useState<ProjectAutomation | "new" | null>(null);
  const [newSeed, setNewSeed] = useState<AutomationFormValue | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const providers = config?.providers ?? [];
  const fallbackModelSelection: ModelSelection =
    project.defaultModelSelection ?? resolveAppModelSelectionState(settings, providers);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const editorSelection =
    editing && editing !== "new" ? editing.modelSelection : fallbackModelSelection;
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        editorSelection.instanceId,
        editorSelection.model,
      ),
    [editorSelection.instanceId, editorSelection.model, providers, settings],
  );
  const data = Option.getOrNull(AsyncResult.value(result));
  const queryError = asyncError(result);

  const execute = async (
    key: string,
    action: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
    onSuccess?: () => void,
  ) => {
    setBusyKey(key);
    setActionError(null);
    const outcome = await action();
    setBusyKey(null);
    if (AsyncResult.isSuccess(outcome)) {
      onSuccess?.();
      return;
    }
    setActionError(asyncError(outcome) ?? "Automation action failed.");
  };

  const editorInitial: AutomationFormValue =
    editing && editing !== "new"
      ? {
          name: editing.name,
          prompt: editing.prompt,
          enabled: editing.enabled,
          cronExpression: editing.cronExpression,
          timeZone: editing.timeZone,
          modelSelection: editing.modelSelection,
          runtimeMode: editing.runtimeMode,
          interactionMode: editing.interactionMode,
          concurrencyPolicy: editing.concurrencyPolicy,
        }
      : (newSeed ?? {
          name: "",
          prompt: "",
          enabled: false,
          cronExpression: DEFAULT_CRON,
          timeZone: browserTimeZone(),
          modelSelection: fallbackModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          concurrencyPolicy: "skip",
        });

  return (
    <SettingsSection
      title="Project automations"
      icon={<CalendarClockIcon className="size-5" />}
      headerAction={
        <Button
          size="sm"
          onClick={() => {
            setNewSeed(null);
            setEditing("new");
            setActionError(null);
          }}
        >
          <PlusIcon /> New automation
        </Button>
      }
    >
      <div className="space-y-3 px-0 sm:px-1">
        {actionError ? (
          <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {actionError}
          </div>
        ) : null}
        {editing ? (
          <AutomationEditor
            key={editing === "new" ? "new" : editing.id}
            initial={editorInitial}
            project={project}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            busy={busyKey === "save"}
            onCancel={() => {
              setEditing(null);
              setNewSeed(null);
            }}
            onSave={async (value) => {
              const textFields = parseAutomationTextFields(value.name, value.prompt);
              if (!textFields.ok) {
                setActionError(textFields.error);
                return;
              }
              const scheduleFields = parseAutomationScheduleFields(
                value.cronExpression,
                value.timeZone,
              );
              if (!scheduleFields.ok) {
                setActionError(scheduleFields.error);
                return;
              }
              const common = {
                ...textFields.value,
                enabled: value.enabled,
                ...scheduleFields.value,
                modelSelection: value.modelSelection,
                runtimeMode: value.runtimeMode,
                interactionMode: value.interactionMode,
                concurrencyPolicy: value.concurrencyPolicy,
              };
              await execute(
                "save",
                () =>
                  editing === "new"
                    ? createAutomation({
                        environmentId: project.environmentId,
                        input: { projectId: project.id, ...common },
                      })
                    : updateAutomation({
                        environmentId: project.environmentId,
                        input: { projectId: project.id, automationId: editing.id, ...common },
                      }),
                () => {
                  setEditing(null);
                  setNewSeed(null);
                },
              );
            }}
          />
        ) : null}

        {result.waiting && data === null ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border py-16 text-sm text-muted-foreground">
            <Spinner /> Loading automations…
          </div>
        ) : queryError && data === null ? (
          <div className="rounded-2xl border border-destructive/25 px-5 py-8 text-sm text-destructive">
            {queryError}
          </div>
        ) : data?.automations.length ? (
          data.automations.map((automation) => {
            const historyOpen = expandedHistory === automation.id;
            return (
              <Card key={automation.id} className="overflow-hidden">
                <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-start sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{automation.name}</h3>
                      <Badge variant={automation.enabled ? "success" : "secondary"}>
                        {automation.enabled ? "Enabled" : "Paused"}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {automation.prompt}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        <code>{automation.cronExpression}</code> · {automation.timeZone}
                      </span>
                      <span>
                        {automation.modelSelection.instanceId} / {automation.modelSelection.model}
                      </span>
                      {automation.modelSelection.options?.map((option) => (
                        <span key={option.id}>{formatModelOption(option.id, option.value)}</span>
                      ))}
                      <span>Overlap: {automation.concurrencyPolicy}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyKey === `run:${automation.id}`}
                      onClick={() =>
                        void execute(
                          `run:${automation.id}`,
                          () =>
                            runNow({
                              environmentId: project.environmentId,
                              input: { projectId: project.id, automationId: automation.id },
                            }),
                          () => setExpandedHistory(automation.id),
                        )
                      }
                    >
                      {busyKey === `run:${automation.id}` ? <Spinner /> : <PlayIcon />} Run now
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${automation.name}`}
                      onClick={() => setEditing(automation)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Duplicate ${automation.name}`}
                      onClick={() => {
                        setNewSeed({
                          name: `${automation.name} copy`,
                          prompt: automation.prompt,
                          enabled: false,
                          cronExpression: automation.cronExpression,
                          timeZone: automation.timeZone,
                          modelSelection: automation.modelSelection,
                          runtimeMode: automation.runtimeMode,
                          interactionMode: automation.interactionMode,
                          concurrencyPolicy: automation.concurrencyPolicy,
                        });
                        setEditing("new");
                      }}
                    >
                      <CopyIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${automation.name}`}
                      disabled={busyKey === `delete:${automation.id}`}
                      onClick={() => {
                        if (!window.confirm(`Delete “${automation.name}” and its run history?`))
                          return;
                        void execute(`delete:${automation.id}`, () =>
                          deleteAutomation({
                            environmentId: project.environmentId,
                            input: { projectId: project.id, automationId: automation.id },
                          }),
                        );
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 border-y bg-muted/25 text-sm sm:grid-cols-4">
                  <div className="border-r px-4 py-3">
                    <p className="text-xs text-muted-foreground">Next run</p>
                    <p className="mt-0.5 font-medium" title={formatDateTime(automation.nextRunAt)}>
                      {automation.enabled ? formatRelative(automation.nextRunAt) : "Paused"}
                    </p>
                  </div>
                  <div className="px-4 py-3 sm:border-r">
                    <p className="text-xs text-muted-foreground">Last started</p>
                    <p className="mt-0.5 font-medium" title={formatDateTime(automation.lastRunAt)}>
                      {formatRelative(automation.lastRunAt)}
                    </p>
                  </div>
                  <div className="border-r border-t px-4 py-3 sm:border-t-0">
                    <p className="text-xs text-muted-foreground">Permissions</p>
                    <p className="mt-0.5 font-medium capitalize">
                      {automation.runtimeMode.replaceAll("-", " ")}
                    </p>
                  </div>
                  <div className="border-t px-4 py-3 sm:border-t-0">
                    <p className="text-xs text-muted-foreground">Mode</p>
                    <p className="mt-0.5 font-medium capitalize">{automation.interactionMode}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between px-4 py-2 sm:px-5">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setExpandedHistory(historyOpen ? null : automation.id)}
                  >
                    {historyOpen ? <ChevronDownIcon /> : <ChevronRightIcon />} <HistoryIcon /> Run
                    history
                  </Button>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{automation.enabled ? "Enabled" : "Paused"}</span>
                    <Switch
                      aria-label={`${automation.enabled ? "Pause" : "Enable"} ${automation.name}`}
                      checked={automation.enabled}
                      disabled={busyKey === `toggle:${automation.id}`}
                      onCheckedChange={(enabled) =>
                        void execute(`toggle:${automation.id}`, () =>
                          updateAutomation({
                            environmentId: project.environmentId,
                            input: {
                              projectId: project.id,
                              automationId: automation.id,
                              enabled: Boolean(enabled),
                            },
                          }),
                        )
                      }
                    />
                  </div>
                </div>
                {historyOpen ? (
                  <div className="border-t px-4 pb-2 sm:px-5">
                    <AutomationHistory automation={automation} project={project} />
                  </div>
                ) : null}
              </Card>
            );
          })
        ) : (
          <div className="rounded-2xl border border-dashed px-5 py-16 text-center">
            <CalendarClockIcon className="mx-auto size-8 text-muted-foreground/60" />
            <h3 className="mt-3 font-medium">No automations for this project</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Create a recurring agent task, or migrate an existing Codex Desktop automation by
              pasting its prompt and schedule.
            </p>
            <Button
              className="mt-5"
              onClick={() => {
                setNewSeed(null);
                setEditing("new");
              }}
            >
              <PlusIcon /> Create automation
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

export function AutomationsSettingsPanel() {
  const projects = useProjects();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const projectKeys = useMemo(
    () => new Set(projects.map((project) => `${project.environmentId}:${project.id}`)),
    [projects],
  );
  const effectiveKey =
    selectedKey && projectKeys.has(selectedKey)
      ? selectedKey
      : projects[0]
        ? `${projects[0].environmentId}:${projects[0].id}`
        : null;
  const selectedProject =
    projects.find((project) => `${project.environmentId}:${project.id}` === effectiveKey) ?? null;

  useEffect(() => {
    if (effectiveKey !== selectedKey) setSelectedKey(effectiveKey);
  }, [effectiveKey, selectedKey]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Automation scope" icon={<Clock3Icon className="size-5" />}>
        <div className="rounded-xl px-3 py-3 sm:grid sm:grid-cols-[1fr_auto] sm:items-center sm:gap-8 sm:px-4">
          <div>
            <h3 className="text-sm font-medium">Project</h3>
            <p className="mt-1 max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
              Automations are owned by a project and execute from that project’s workspace root.
            </p>
          </div>
          {projects.length > 0 ? (
            <Select
              value={effectiveKey ?? undefined}
              onValueChange={(value) => setSelectedKey(value)}
            >
              <SelectTrigger
                className="mt-3 w-full sm:mt-0 sm:w-72"
                aria-label="Automation project"
              >
                <SelectValue>{selectedProject?.title ?? "Select a project"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {projects.map((project) => {
                  const key = `${project.environmentId}:${project.id}`;
                  return (
                    <SelectItem key={key} value={key}>
                      {project.title}
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          ) : (
            <span className="mt-3 text-sm text-muted-foreground sm:mt-0">
              No projects available
            </span>
          )}
        </div>
      </SettingsSection>
      {selectedProject ? (
        <AutomationProjectPanel key={effectiveKey} project={selectedProject} />
      ) : null}
    </SettingsPageContainer>
  );
}
