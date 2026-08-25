import type { EnvironmentId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { adeEnvironment, useAdeEnvironmentId, useAdeRoster } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { rosterNeedsFirstProject } from "./contactRail.logic";

/**
 * What the conversation region says at `/fleet` — no contact selected yet.
 * It also carries the #141 first-run CTA that `FleetRosterPage` used to own,
 * because a captain with no project needs that before they need a chat.
 */
export function CaptainIndexPane() {
  const environmentId = useAdeEnvironmentId();
  const roster = useAdeRoster();

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-md flex-col gap-6">
        {rosterNeedsFirstProject(roster.data) ? (
          <FirstProjectCta environmentId={environmentId} />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Pick a bot</EmptyTitle>
              <EmptyDescription>
                Choose a contact to open the conversation, or add a new bot from a template.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

/**
 * The empty-state CTA (#141). It creates an **ADE** project — the thing that
 * owns a crew and auto-creates a Second Mate — not a shuv2code workspace
 * project. Pointing this at the generic workspace palette left the fleet with
 * no ADE projects at all: the Project combobox stayed permanently empty, every
 * bot was fleet-wide, and the auto-Second-Mate hook was unreachable.
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
