import type { AdeBotTemplateId, AdeProjectId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { templateOptionLabel } from "./contactRail.logic";

/** Sentinel for "no home project" — a fleet-shared specialist. */
const NO_PROJECT = "__none__";

/**
 * The rail's `[+]` new-bot control (§2). This is `FleetRosterPage`'s
 * `AddFromTemplateControl` flow moved behind a popover — same RPC, same
 * refusal handling, same wording — because the rail replaces the page that
 * used to host it and creating a bot must not go missing in the move.
 */
export function NewBotPopover({
  collapsed,
  projects,
  templates,
}: {
  readonly collapsed: boolean;
  readonly projects: ReadonlyArray<{ readonly id: AdeProjectId; readonly name: string }>;
  readonly templates: ReadonlyArray<{
    readonly templateId: AdeBotTemplateId;
    readonly defaultName: string;
    readonly roleTag: string;
  }>;
}) {
  const environmentId = useAdeEnvironmentId();
  const createBot = useAtomCommand(adeEnvironment.createBotFromTemplate, { reportFailure: false });
  const [open, setOpen] = useState(false);
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
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button aria-label="New bot" size="icon-sm" variant="ghost">
                  <PlusIcon />
                </Button>
              }
            />
          }
        />
        <TooltipPopup side={collapsed ? "right" : "bottom"}>New bot</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-72" side="bottom">
        <div className="flex w-full flex-col gap-2 p-3">
          <span className="text-sm font-medium">Add from template</span>
          <Select
            onValueChange={(value) => setTemplateId((value as AdeBotTemplateId) || null)}
            value={templateId ?? ""}
          >
            <SelectTrigger aria-label="Template">
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
          <Select onValueChange={(value) => setProjectId(String(value))} value={projectId}>
            <SelectTrigger aria-label="Project">
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
            onChange={(event) => setName(event.target.value)}
            placeholder={selected?.defaultName ?? "Name (optional)"}
            value={name}
          />
          <Button disabled={!canAdd} onClick={() => void handleAdd()} size="sm">
            <PlusIcon />
            Add
          </Button>
          {error === null ? null : (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
