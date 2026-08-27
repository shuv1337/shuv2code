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
import { useEffect, useMemo, useState } from "react";

import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage, adeCaptainErrorReason } from "../../state/ade.logic";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  canSaveMemory,
  getPersonaVersionViews,
  PERSONA_EDIT_NOTE,
} from "../fleet/BotDetailPanel.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  ADE_MODEL_INSTANCE_ID,
  BOT_MODEL_NEXT_SESSION_NOTE,
  BOT_MODEL_RESTART_NOTE,
  BOT_MODEL_UNSUPPORTED_HINT,
  getBotModelOptions,
  getBotModelSavedMessage,
  hasLivePrimarySession,
  isFlaggedBotModel,
  shouldSubmitBotModel,
} from "./botModel.logic";

const NO_PROVIDERS: ReadonlyArray<never> = [];

/**
 * Which model this bot runs on (issue #223 follow-up).
 *
 * This control exists because there was none: a bot ran whatever the kernel
 * listed first, and the only way to change it was to hand-edit a projection
 * row. Everything opinionated about it is in `botModel.logic` — most of all
 * that a model the kernel reports as tool-incapable is *listed and
 * selectable*, marked rather than hidden.
 *
 * Saving is explicit rather than on-change, and never says "Saved." alone: a
 * live session keeps the model it was created with, so the outcome line always
 * states which of the two things happened. "Restart now" is the second,
 * deliberate tap that makes it immediate.
 */
export function BotModelPicker({
  botId,
  detail,
}: {
  readonly botId: BotId;
  readonly detail: AdeBotDetail;
}) {
  const environmentId = useAdeEnvironmentId();
  const providers = usePrimaryEnvironment()?.serverConfig?.providers ?? NO_PROVIDERS;
  const setBotModel = useAtomCommand(adeEnvironment.setBotModel, { reportFailure: false });
  const options = useMemo(() => getBotModelOptions(providers), [providers]);
  const current = detail.modelSlug ?? null;
  const live = hasLivePrimarySession(detail.bindings);
  const [draft, setDraft] = useState<string | null>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The bot detail re-reads on the 15s poll and after every sibling save, so
  // adopting the server's slug is only safe while the captain has not picked
  // something else — otherwise a poll lands on top of an open choice.
  const [adopted, setAdopted] = useState(current);
  useEffect(() => {
    if (current !== adopted) {
      setAdopted(current);
      setDraft(current);
    }
  }, [adopted, current]);

  const submit = async (restartSession: boolean) => {
    if (environmentId === null) return;
    if (!shouldSubmitBotModel(current, draft, restartSession)) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await setBotModel({
      environmentId,
      input: {
        botId,
        modelSelection: { instanceId: ADE_MODEL_INSTANCE_ID, model: draft },
        ...(restartSession ? { restartSession: true } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        adeCaptainErrorMessage(squashAtomCommandFailure(result), "The model could not be changed."),
      );
      return;
    }
    setSaved(getBotModelSavedMessage(result.value));
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Model</h2>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The shuvcode kernel is not reporting any models. Check Settings → Providers, then reopen
          this sheet.
        </p>
      ) : (
        <>
          <Select
            items={options.map((option) => ({ value: option.slug, label: option.label }))}
            value={draft ?? ""}
            onValueChange={(value) => setDraft(String(value))}
          >
            <SelectTrigger aria-label="Bot model" className="w-full">
              <SelectValue placeholder="Kernel default" />
            </SelectTrigger>
            <SelectPopup>
              {options.map((option) => (
                <SelectItem key={option.slug} value={option.slug}>
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="truncate">{option.label}</span>
                    {option.isKernelDefault ? (
                      <Badge size="sm" variant="secondary">
                        Kernel default
                      </Badge>
                    ) : null}
                    {option.agentCapable ? null : (
                      <Badge size="sm" variant="outline">
                        {BOT_MODEL_UNSUPPORTED_HINT}
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {isFlaggedBotModel(options, draft) ? (
            <p className="text-xs text-muted-foreground" role="status">
              {`${draft} does not report tool calling on this kernel. It stays selectable — the report can be wrong — but the bot may be unable to delegate.`}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={busy || !shouldSubmitBotModel(current, draft, false)}
              onClick={() => void submit(false)}
              size="sm"
            >
              Save model
            </Button>
            {/* Offered only when something is actually still running the old
                model — otherwise the setting is already in force. */}
            {live ? (
              <Button
                disabled={busy || draft === null || draft.length === 0}
                onClick={() => void submit(true)}
                size="sm"
                title={BOT_MODEL_RESTART_NOTE}
                variant="outline"
              >
                Restart with this model
              </Button>
            ) : null}
            {live ? (
              <span className="text-xs text-muted-foreground">{BOT_MODEL_NEXT_SESSION_NOTE}</span>
            ) : null}
          </div>
        </>
      )}
      {saved === null ? null : (
        <p className="text-sm text-success-foreground" role="status">
          {saved}
        </p>
      )}
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

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
