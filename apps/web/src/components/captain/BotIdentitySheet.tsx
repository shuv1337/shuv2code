/**
 * The bot identity sheet (`docs/ade/MESSENGER-PIVOT.md` §3, ticket M2 / #197).
 *
 * One place to answer "who is this contact": the loose part of a bot's
 * identity — name, emoji, color, role tag, group — sitting above the
 * persona/memory/computer-use forms lifted out of `fleet/BotDetailPanel`.
 *
 * Two things it deliberately does not do:
 *
 * - It never disables rename for the Firstmate. Permanence is about existence,
 *   not about the label (spec §2.2), and a greyed-out field would teach the
 *   captain a rule the server does not actually have.
 * - It shows the structural role and the bot's home project as **chips**, not
 *   fields. They are server-owned facts; `AdeUpdateBotIdentityInput` has no
 *   key for either, so there is nothing to disable — the strictness is in the
 *   payload shape rather than in the styling.
 *
 * Mounted from `BotIdentityHeaderActions`, which the conversation route hands
 * to `CaptainShell`'s `conversationHeaderActions` seam. It takes an
 * `AdeBotDetail` rather than reading one, so the same sheet can be opened from
 * anywhere that already holds the bot — a contact row's context menu, say —
 * without a second read of the same thing.
 */
import type { AdeBotDetail, AdeBotGroup } from "@shuv2code/contracts";
import { AnchorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { structuralRoleLabel } from "../../state/ade.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../ui/sheet";
import {
  BOT_EMOJI_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_ROLE_TAG_MAX_LENGTH,
  buildBotIdentityPatch,
  getBotIdentityValidationMessage,
  getGroupAssignOptions,
  openBotIdentitySheet,
  reconcileBotIdentitySheet,
  ROLE_TAG_ROUTING_HINT,
  type BotIdentityDraft,
} from "./botIdentity.logic";
import { BotColorSwatches } from "./BotColorSwatches";
import { BotComputerUseToggle, BotMemoryEditor, BotPersonaEditor } from "./BotIdentityForms";
import { GroupAssignMenu } from "./GroupAssignMenu";
import { useBotIdentityUpdate } from "./useBotIdentity";

export function BotIdentitySheet({
  detail,
  groups,
  open,
  onOpenChange,
}: {
  readonly detail: AdeBotDetail;
  readonly groups: ReadonlyArray<AdeBotGroup>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const bot = detail.bot;
  const [state, setState] = useState(() => openBotIdentitySheet(bot));
  const identity = useBotIdentityUpdate("The identity was not saved.");
  const wasOpen = useRef(open);

  /**
   * Opening adopts the server's copy; staying open only adopts it while the
   * draft is untouched.
   *
   * The bot prop changes on the 15-second roster poll and on every sibling
   * control's re-read — flipping computer use inside this very sheet is enough
   * — so an unconditional re-seed here silently ate whatever the captain was
   * typing. `reconcileBotIdentitySheet` is where that decision lives and is
   * tested.
   */
  useEffect(() => {
    if (open && !wasOpen.current) {
      setState(openBotIdentitySheet(bot));
    } else if (open) {
      setState((previous) => reconcileBotIdentitySheet(previous, bot));
    }
    wasOpen.current = open;
  }, [bot, open]);

  const draft = state.draft;
  const setDraft = (update: (previous: BotIdentityDraft) => BotIdentityDraft) => {
    setState((previous) => ({ ...previous, draft: update(previous.draft) }));
  };
  const validation = getBotIdentityValidationMessage(draft);
  const patch = validation === null ? buildBotIdentityPatch(bot, draft) : null;
  const groupLabel =
    getGroupAssignOptions(groups, bot.groupId).find((option) => option.selected)?.label ??
    "Ungrouped";

  const handleSave = async () => {
    if (validation !== null) return;
    const ok = await identity.submit(patch);
    if (ok) onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {bot.structuralRole === "firstmate" ? (
              <AnchorIcon aria-label="Firstmate" className="size-4 text-muted-foreground" />
            ) : null}
            <span className="min-w-0 truncate">{bot.name}</span>
          </SheetTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* Server-owned facts. Chips, not fields. */}
            <Badge size="sm" variant="outline">
              {structuralRoleLabel(bot.structuralRole)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {detail.projectName ?? "Fleet-wide"}
            </span>
          </div>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Name</span>
              <Input
                aria-label="Bot name"
                maxLength={BOT_NAME_MAX_LENGTH}
                value={draft.name}
                onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              />
            </label>
            <div className="flex gap-3">
              <label className="flex w-24 flex-col gap-1 text-sm">
                <span className="font-medium">Emoji</span>
                <Input
                  aria-label="Bot emoji"
                  className="text-center text-lg"
                  maxLength={BOT_EMOJI_MAX_LENGTH}
                  placeholder="🤖"
                  value={draft.emoji}
                  onChange={(event) => setDraft((prev) => ({ ...prev, emoji: event.target.value }))}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="font-medium">Role tag</span>
                <Input
                  aria-label="Bot role tag"
                  maxLength={BOT_ROLE_TAG_MAX_LENGTH}
                  placeholder="Coder"
                  value={draft.roleTag}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, roleTag: event.target.value }))
                  }
                />
                {/* The tag is not only decoration — see ROLE_TAG_ROUTING_HINT. */}
                <span className="text-xs text-muted-foreground">{ROLE_TAG_ROUTING_HINT}</span>
              </label>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <span className="font-medium">Color</span>
              <BotColorSwatches
                value={draft.color}
                onChange={(color) => setDraft((prev) => ({ ...prev, color }))}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">Group</span>
              <GroupAssignMenu
                bot={bot}
                groups={groups}
                trigger={
                  <Button size="sm" variant="outline">
                    {groupLabel}
                  </Button>
                }
              />
            </div>
            {state.changedElsewhere ? (
              <p className="text-xs text-muted-foreground" role="status">
                This bot changed elsewhere while you were editing. Your changes are kept; saving
                overwrites the other ones.
              </p>
            ) : null}
            {validation === null ? null : (
              <p className="text-sm text-destructive" role="alert">
                {validation}
              </p>
            )}
            {identity.error === null ? null : (
              <p className="text-sm text-destructive" role="alert">
                {identity.error}
              </p>
            )}
            <Button
              className="self-start"
              disabled={identity.busy || validation !== null || patch === null}
              size="sm"
              onClick={() => void handleSave()}
            >
              {identity.busy ? "Saving…" : "Save identity"}
            </Button>
          </section>

          <BotComputerUseToggle botId={bot.id} detail={detail} />
          <BotPersonaEditor botId={bot.id} detail={detail} />
          <BotMemoryEditor botId={bot.id} detail={detail} />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
