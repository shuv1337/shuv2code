/**
 * Identity mutations for the captain surface (`docs/ade/MESSENGER-PIVOT.md`
 * §3, ticket T2 / #197).
 *
 * Two hooks, one RPC. `useBotIdentityUpdate` is the plumbing every identity
 * control shares; `useInlineBotRename` is the editable-name behavior the
 * conversation header needs — exported from here rather than owned by the
 * header so the shell (T1) can mount it without importing the whole sheet.
 */
import type { AdeUpdateBotIdentityInput, Bot } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";

import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildBotIdentityPatch, getBotIdentityDraft } from "./botIdentity.logic";

export interface BotIdentityUpdate {
  readonly busy: boolean;
  readonly error: string | null;
  readonly clearError: () => void;
  /** Resolves true when the patch landed (or when there was nothing to send). */
  readonly submit: (patch: AdeUpdateBotIdentityInput | null) => Promise<boolean>;
}

/**
 * Send one identity patch.
 *
 * A null patch resolves true without a round trip: "nothing changed" and
 * "saved" are the same outcome from the captain's side, and firing an empty
 * update on every blur would make the roster re-read for no reason.
 */
export function useBotIdentityUpdate(fallbackMessage: string): BotIdentityUpdate {
  const environmentId = useAdeEnvironmentId();
  const updateIdentity = useAtomCommand(adeEnvironment.updateBotIdentity, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (patch: AdeUpdateBotIdentityInput | null) => {
      if (patch === null) return true;
      if (environmentId === null) return false;
      setBusy(true);
      setError(null);
      try {
        const result = await updateIdentity({ environmentId, input: patch });
        if (result._tag === "Failure") {
          setError(adeCaptainErrorMessage(squashAtomCommandFailure(result), fallbackMessage));
          return false;
        }
        return true;
      } finally {
        setBusy(false);
      }
    },
    [environmentId, fallbackMessage, updateIdentity],
  );

  return { busy, error, clearError: useCallback(() => setError(null), []), submit };
}

export interface InlineBotRename {
  readonly editing: boolean;
  readonly draft: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly setDraft: (next: string) => void;
  readonly start: () => void;
  readonly cancel: () => void;
  readonly commit: () => Promise<void>;
  /** Wire onto the input: Enter commits, Escape abandons. */
  readonly onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
}

/**
 * Inline rename for the conversation header.
 *
 * Renaming is offered for **every** bot, the Firstmate included: permanence
 * protects that the Firstmate exists (spec §2.2), not the label on its contact
 * row. There is deliberately no `disabled` branch here — a control that
 * refuses a legal action is worse than no control.
 *
 * A failed commit keeps the editor open with the captain's text intact. The
 * alternative — snapping back to the server's name and showing a toast — loses
 * what they typed to make room for an explanation of why it was lost.
 */
export function useInlineBotRename(bot: Bot | null): InlineBotRename {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bot?.name ?? "");
  const { busy, error, clearError, submit } = useBotIdentityUpdate("The bot was not renamed.");

  // A rename that landed elsewhere (or a different bot arriving under the same
  // header) must not be overwritten by a stale draft — but only while the
  // captain is not mid-edit, or their typing would be yanked out from under
  // them by the next poll.
  const serverName = bot?.name ?? "";
  useEffect(() => {
    if (!editing) setDraft(serverName);
  }, [editing, serverName]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(serverName);
    clearError();
  }, [clearError, serverName]);

  const commit = useCallback(async () => {
    if (bot === null) return;
    const trimmed = draft.trim();
    // An emptied field is an abandoned edit, not a request to delete the name:
    // the patch has no way to clear it, so treating blank as cancel is the
    // only reading that is not a silent failure.
    if (trimmed.length === 0) {
      cancel();
      return;
    }
    const patch = buildBotIdentityPatch(bot, { ...getBotIdentityDraft(bot), name: trimmed });
    const ok = await submit(patch);
    if (ok) setEditing(false);
  }, [bot, cancel, draft, submit]);

  return {
    editing,
    draft,
    busy,
    error,
    setDraft,
    start: useCallback(() => {
      setDraft(serverName);
      setEditing(true);
    }, [serverName]),
    cancel,
    commit,
    onKeyDown: useCallback(
      (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      },
      [cancel, commit],
    ),
  };
}
