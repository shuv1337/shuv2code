import type { EnvironmentId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { adeEnvironment, useAdeEnvironmentId, useAdeRoster } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { rosterNeedsFirstProject, type ContactRailFilter } from "./contactRail.logic";

/**
 * What the conversation region says at `/fleet` — no contact selected yet.
 * It also carries the #141 first-run CTA that `FleetRosterPage` used to own,
 * because a captain with no project needs that before they need a chat.
 */
export function CaptainIndexPane({ filter = "all" }: { readonly filter?: ContactRailFilter }) {
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
              {/*
                Arriving here from the retired needs-you inbox — or from the
                sidebar badge — the captain came to answer something, so the
                pane names that rather than repeating the generic index copy.
              */}
              <EmptyTitle>
                {filter === "attention" ? "Pick what to answer" : "Pick a bot"}
              </EmptyTitle>
              <EmptyDescription>
                {filter === "attention"
                  ? "The rail is showing only the bots waiting on you. Open one to decide it."
                  : "Choose a contact to open the conversation, or add a new bot from a template."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

/**
 * Whether the first-project CTA can be submitted (#212).
 *
 * Pure and exported so the *reason* a repository path is mandatory is asserted
 * once rather than inferred from a disabled attribute: an ADE project with no
 * repo binding can never start a chat, and nothing in the app can bind one
 * afterwards. The same predicate gates the button and the submit handler, so a
 * keyboard Enter cannot bypass what the button refuses.
 */
export function canSubmitFirstProject(input: {
  readonly environmentId: EnvironmentId | null;
  readonly name: string;
  readonly repoPath: string;
  readonly busy: boolean;
}): boolean {
  return (
    !input.busy &&
    input.environmentId !== null &&
    input.name.trim().length > 0 &&
    input.repoPath.trim().length > 0
  );
}

/**
 * The empty-state CTA (#141). It creates an **ADE** project — the thing that
 * owns a crew and auto-creates a Second Mate — not a shuv2code workspace
 * project. Pointing this at the generic workspace palette left the fleet with
 * no ADE projects at all: the Project combobox stayed permanently empty, every
 * bot was fleet-wide, and the auto-Second-Mate hook was unreachable.
 */
export function FirstProjectCta({
  className,
  environmentId,
}: {
  readonly className?: string;
  readonly environmentId: EnvironmentId | null;
}) {
  const createProject = useAtomCommand(adeEnvironment.createProject, { reportFailure: false });
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    // The narrowing is spelled out here rather than inferred from the
    // predicate: `canSubmitFirstProject` is the single source of the *rule*,
    // and this is what makes the compiler agree the environment is present.
    if (!canSubmitFirstProject({ environmentId, name, repoPath, busy })) return;
    if (environmentId === null) return;
    setBusy(true);
    setError(null);
    const result = await createProject({
      environmentId,
      input: { name: name.trim(), repoPath: repoPath.trim() },
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
    <Empty className={cn("rounded-lg border border-border", className)}>
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
          placeholder="Repository path"
          required
          value={repoPath}
        />
        {/*
          #212: the field used to say "(optional)", and it was not. A project
          with no repository has nowhere for its bots to run, so the first
          message to any of them fails — and there is no in-app way to bind a
          repo afterwards, which makes the optionality a one-way trap rather
          than a deferred decision. Requiring it here removes the trap at the
          only moment the captain can act on it.
        */}
        <p className="text-xs text-muted-foreground">
          Bots run inside this repository, so a project needs one before it can chat.
        </p>
        <Button
          className="self-start"
          disabled={!canSubmitFirstProject({ environmentId, name, repoPath, busy })}
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
