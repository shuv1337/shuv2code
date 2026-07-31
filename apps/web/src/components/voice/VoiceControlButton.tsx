import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
} from "@shuv2code/contracts";
import { MicIcon } from "lucide-react";
import { useState } from "react";

import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface VoiceControlButtonProps {
  readonly environmentId: EnvironmentId;
  readonly hostProjectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly realtimeEnabled: boolean;
  readonly threadReadEnabled: boolean;
  readonly threadControlEnabled: boolean;
  readonly compact?: boolean;
}

export function VoiceControlButton(props: VoiceControlButtonProps) {
  const voice = useVoiceSession();
  const [setupOpen, setSetupOpen] = useState(false);
  const [ceiling, setCeiling] = useState<RuntimeMode>("approval-required");
  const active = voice.state.phase.type !== "idle" && voice.state.phase.type !== "unsupported";
  const pending =
    voice.state.phase.type === "requesting-permission" ||
    voice.state.phase.type === "negotiating" ||
    voice.state.phase.type === "reconnecting";
  const unavailableReason = !props.realtimeEnabled
    ? "Realtime voice is disabled in server settings"
    : !props.threadReadEnabled
      ? "Voice thread status is disabled in server settings"
      : null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size={props.compact ? "icon-sm" : "sm"}
              variant={active ? "secondary" : "ghost"}
              className={active ? undefined : "text-muted-foreground/70 hover:text-foreground/80"}
              aria-label={
                active
                  ? "Voice control active"
                  : unavailableReason
                    ? `Voice control unavailable: ${unavailableReason}`
                    : "Set up voice control"
              }
              disabled={active || pending || unavailableReason !== null}
              onClick={() => setSetupOpen(true)}
            >
              <MicIcon />
              {props.compact ? null : <span className="hidden sm:inline">Voice</span>}
            </Button>
          }
        />
        <TooltipPopup side="top">
          {active
            ? "Voice control is active in the tray"
            : (unavailableReason ?? "Set up voice control")}
        </TooltipPopup>
      </Tooltip>
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Start voice control</DialogTitle>
            <DialogDescription>
              Confirm the exact controller host, Codex provider, and maximum authority before
              microphone access is requested.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="font-medium">Host project</dt>
                <dd className="break-all font-mono text-muted-foreground">{props.hostProjectId}</dd>
              </div>
              <div>
                <dt className="font-medium">Codex provider instance</dt>
                <dd className="break-all font-mono text-muted-foreground">
                  {props.providerInstanceId}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Controller model</dt>
                <dd className="break-all font-mono text-muted-foreground">
                  {props.modelSelection.model}
                </dd>
              </div>
            </dl>
            <label className="block space-y-1.5 text-sm font-medium">
              Thread-control authority ceiling
              <select
                className="h-9 w-full rounded-lg border border-input bg-background px-3 font-normal"
                value={ceiling}
                onChange={(event) => setCeiling(event.target.value as RuntimeMode)}
              >
                <option value="approval-required">Approval required (recommended)</option>
                <option value="auto-accept-edits">Auto-accept edits</option>
                <option value="auto">Automatic</option>
                <option value="full-access">Full access</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Effective voice authority is also limited by the controller and target runtime modes.
              Raising this ceiling later requires reauthorization.
            </p>
            {!props.threadControlEnabled ? (
              <p className="rounded-lg border border-border bg-muted/64 p-3 text-sm">
                Thread control is disabled. Voice will run in read-only status mode and cannot
                create, steer, or stop target threads.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSetupOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setSetupOpen(false);
                void voice.start({
                  environmentId: props.environmentId,
                  hostProjectId: props.hostProjectId,
                  providerInstanceId: props.providerInstanceId,
                  modelSelection: props.modelSelection,
                  authorizedRuntimeCeiling: ceiling,
                });
              }}
            >
              {props.threadControlEnabled ? "Confirm and start" : "Start read-only voice"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
