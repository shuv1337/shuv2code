import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@shuv2code/client-runtime/state/runtime";
import type {
  EnvironmentId,
  VcsDriverKind,
  VcsSelectableKind,
  VcsStatusResult,
} from "@shuv2code/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { GitIcon, JujutsuIcon } from "./Icons";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { toastManager } from "./ui/toast";
import { vcsEnvironment } from "../state/vcs";
import { useAtomCommand } from "../state/use-atom-command";
import { shouldShowVcsSelector } from "./BranchToolbar.logic";

function vcsKindLabel(kind: VcsDriverKind | undefined): string {
  if (kind === "jj") return "Jujutsu";
  if (kind === "git") return "Git";
  return "Version control";
}

interface BranchToolbarVcsSelectorProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly status: VcsStatusResult;
}

export function BranchToolbarVcsSelector({
  environmentId,
  cwd,
  status,
}: BranchToolbarVcsSelectorProps) {
  const setProjectPreference = useAtomCommand(vcsEnvironment.setProjectPreference, {
    reportFailure: false,
  });
  const [pendingKind, setPendingKind] = useState<VcsSelectableKind | "default" | null>(null);
  const selection = status.selection;

  if (!shouldShowVcsSelector(selection)) return null;

  const setPreference = (value: string) => {
    if (pendingKind !== null) return;
    const kind = value === "default" ? null : (value as VcsSelectableKind);
    setPendingKind(kind ?? "default");
    void (async () => {
      const result = await setProjectPreference({
        environmentId,
        input: { cwd, kind },
      });
      setPendingKind(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not change version control",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: `Using ${vcsKindLabel(result.value.kind)}`,
        description:
          kind === null
            ? `This project now follows the ${vcsKindLabel(selection.defaultKind)} default.`
            : `This project now uses ${vcsKindLabel(kind)} explicitly.`,
      });
    })();
  };

  const ActiveIcon = status.kind === "jj" ? JujutsuIcon : GitIcon;
  const selectionValue = selection.projectKind ?? "default";

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon-xs" />}
        aria-label={`Version control: ${vcsKindLabel(status.kind)}`}
        className="shrink-0 text-muted-foreground/70 hover:text-foreground/80"
      >
        <ActiveIcon className="size-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>Version control</MenuGroupLabel>
          <MenuRadioGroup value={selectionValue} onValueChange={setPreference}>
            {selection.availableKinds.map((kind) => {
              const Icon = kind === "jj" ? JujutsuIcon : GitIcon;
              return (
                <MenuRadioItem key={kind} value={kind} disabled={pendingKind !== null}>
                  <Icon className="size-3" />
                  {vcsKindLabel(kind)}
                </MenuRadioItem>
              );
            })}
            <MenuSeparator />
            <MenuRadioItem value="default" disabled={pendingKind !== null}>
              <RefreshCwIcon className="size-3" />
              Follow default ({vcsKindLabel(selection.defaultKind)})
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {selection.source === "fallback" ? (
          <p className="px-2 py-1.5 text-xs text-warning">
            The selected version control system is unavailable in this project.
          </p>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
