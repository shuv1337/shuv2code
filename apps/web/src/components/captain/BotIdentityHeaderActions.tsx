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
 */
import type { BotId } from "@shuv2code/contracts";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";

import { useAdeBotDetail, useAdeBotGroups } from "../../state/ade";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BotAvatar } from "./BotAvatar";
import { BotIdentitySheet } from "./BotIdentitySheet";
import { getBotAvatarView } from "./contactRail.logic";
import { useInlineBotRename } from "./useBotIdentity";

export function BotIdentityHeaderActions({ botId }: { readonly botId: BotId }) {
  const detail = useAdeBotDetail(botId);
  const groups = useAdeBotGroups();
  const bot = detail.data?.bot ?? null;
  const rename = useInlineBotRename(bot);
  const [identityOpen, setIdentityOpen] = useState(false);

  // The header is sticky and always mounted; the bot arrives a tick later.
  // Rendering nothing beats rendering a skeleton that shifts the whole row.
  if (detail.data === null || bot === null) {
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
      <BotIdentitySheet
        detail={detail.data}
        groups={groups}
        open={identityOpen}
        onOpenChange={setIdentityOpen}
      />
    </>
  );
}
