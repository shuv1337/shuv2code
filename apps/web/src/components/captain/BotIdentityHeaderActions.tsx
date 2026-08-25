/**
 * The conversation header's identity controls (MESSENGER-PIVOT §3, M2 / #197).
 *
 * This is what mounts into `CaptainShell`'s `conversationHeaderActions` seam:
 * the bot's blob, its name as an **inline rename**, its role chip, and a gear
 * that opens `BotIdentitySheet`. Packaged as one component so the route hands
 * the shell a single node and every identity concern stays in `captain/`.
 *
 * Renaming is offered for every bot, the Firstmate included — permanence
 * protects that the Firstmate exists (spec §2.2), not the label on its contact
 * row — so there is deliberately no disabled branch here.
 *
 * **The chrome reads the roster, not the bot detail.** Both carry the same
 * `Bot`, but the roster is already loaded — it is what drew the contact rail
 * the captain clicked to get here — while `ade.getBot` is a second read that
 * can be pending or can fail. Hanging the name, the blob and the gear off the
 * slower one meant a header that renders empty, and an identity sheet with no
 * way in, whenever that read did not land. Only the sheet's persona/memory
 * forms genuinely need the detail, so only they wait for it.
 */
import type { Bot, BotId } from "@shuv2code/contracts";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";

import { useAdeBotDetail, useAdeBotGroups, useAdeRoster } from "../../state/ade";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BotAvatar } from "./BotAvatar";
import { BotIdentitySheet } from "./BotIdentitySheet";
import { getBotAvatarView } from "./contactRail.logic";
import { useInlineBotRename } from "./useBotIdentity";

export function BotIdentityHeaderActions({ botId }: { readonly botId: BotId }) {
  const roster = useAdeRoster();
  const detail = useAdeBotDetail(botId);
  const groups = useAdeBotGroups();

  const rosterBot = roster.data?.entries.find((entry) => entry.bot.id === botId)?.bot ?? null;
  // Detail wins when it is there — it is the copy a save round-trips against —
  // but the roster is what makes the header appear at all.
  const bot: Bot | null = detail.data?.bot ?? rosterBot;
  const rename = useInlineBotRename(bot);
  const [identityOpen, setIdentityOpen] = useState(false);

  // Neither read knows this bot yet. Rendering nothing beats a skeleton that
  // would shift the whole header row a moment later.
  if (bot === null) {
    return null;
  }

  const avatar = getBotAvatarView({
    botId: bot.id,
    name: bot.name,
    displayMeta: bot.displayMeta,
  });

  return (
    <>
      <BotAvatar avatar={avatar} size="sm" />
      {rename.editing ? (
        <Input
          aria-label="Bot name"
          autoFocus
          className="h-7 max-w-56 text-sm font-semibold"
          disabled={rename.busy}
          value={rename.draft}
          onBlur={() => void rename.commit()}
          onChange={(event) => rename.setDraft(event.target.value)}
          onKeyDown={rename.onKeyDown}
        />
      ) : (
        <button
          className="min-w-0 truncate rounded px-1 text-sm font-semibold hover:bg-accent"
          title="Rename"
          type="button"
          onClick={rename.start}
        >
          {bot.name}
        </button>
      )}
      <Badge className="max-sm:hidden" size="sm" variant="secondary">
        {bot.roleTag}
      </Badge>
      {rename.error === null ? null : (
        <span className="truncate text-xs text-destructive" role="alert">
          {rename.error}
        </span>
      )}
      <Button
        aria-label="Bot identity"
        size="icon-sm"
        variant="ghost"
        onClick={() => setIdentityOpen(true)}
      >
        <SettingsIcon />
      </Button>
      {/*
       * The sheet is the one part that needs the detail read. Opening the gear
       * before it lands is not an error — the sheet appears as soon as the
       * read resolves, which is normally the same tick the conversation itself
       * becomes usable.
       */}
      {detail.data === null ? null : (
        <BotIdentitySheet
          detail={detail.data}
          groups={groups}
          open={identityOpen}
          onOpenChange={setIdentityOpen}
        />
      )}
    </>
  );
}
