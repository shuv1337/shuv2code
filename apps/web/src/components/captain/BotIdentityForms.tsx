/**
 * The captain-editable forms that used to live inside `fleet/BotDetailPanel`
 * (`docs/ade/MESSENGER-PIVOT.md` §3: "hosts persona/memory/computer-use forms
 * lifted verbatim from BotDetailPanel").
 *
 * Lifted rather than copied: the detail panel now renders these same
 * components, so the tab chrome can be deleted in a later ticket without
 * anyone having to diff two drifted implementations of the memory editor
 * first. Behavior is unchanged — including the conflict handling, which is the
 * part most likely to be quietly lost in a rewrite.
 */
import type { AdeBotDetail, BotId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage, adeCaptainErrorReason } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  canSaveMemory,
  getPersonaVersionViews,
  PERSONA_EDIT_NOTE,
} from "../fleet/BotDetailPanel.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

export function BotComputerUseToggle({
  botId,
  detail,
}: {
  readonly botId: BotId;
  readonly detail: AdeBotDetail;
}) {
  const environmentId = useAdeEnvironmentId();
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
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>
          <span className="block font-medium">Computer use</span>
          <span className="text-xs text-muted-foreground">
            Lets this bot drive a Screenbox desktop.
          </span>
        </span>
        <Switch
          aria-label="Computer use"
          checked={detail.bot.computerUse}
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

export function BotMemoryEditor({
  botId,
  detail,
}: {
  readonly botId: BotId;
  readonly detail: AdeBotDetail;
}) {
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

export function BotPersonaEditor({
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
