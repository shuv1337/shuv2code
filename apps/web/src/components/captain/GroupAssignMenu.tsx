/**
 * Menu-first group assignment (`docs/ade/MESSENGER-PIVOT.md` §2, §3 — T2/#197).
 *
 * Drag-and-drop is the affordance a captain reaches for once they know the
 * rail; this menu is the path that always works — keyboard, touch, screen
 * reader, and the very first time. It is a standalone component so the shell
 * (T1) can mount it from a contact row's context menu and the identity sheet
 * can mount the same control, without either owning the other.
 */
import type { AdeBotGroup, AdeBotGroupId, Bot } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { CheckIcon, FolderPlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  buildBotIdentityPatch,
  getBotIdentityDraft,
  getGroupAssignOptions,
  getGroupNameValidationMessage,
} from "./botIdentity.logic";
import { useBotIdentityUpdate } from "./useBotIdentity";

export function GroupAssignMenu({
  bot,
  groups,
  trigger,
}: {
  readonly bot: Bot;
  readonly groups: ReadonlyArray<AdeBotGroup>;
  /** The control that opens the menu; the rail and the sheet render different ones. */
  readonly trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const environmentId = useAdeEnvironmentId();
  const upsertGroup = useAtomCommand(adeEnvironment.upsertBotGroup, { reportFailure: false });
  const assign = useBotIdentityUpdate("The bot was not moved.");
  const options = getGroupAssignOptions(groups, bot.groupId);

  const moveTo = async (groupId: AdeBotGroupId | null) => {
    const patch = buildBotIdentityPatch(bot, { ...getBotIdentityDraft(bot), groupId });
    const ok = await assign.submit(patch);
    if (ok) setOpen(false);
  };

  // Create-and-file in one gesture: a captain who opens this menu wanting a
  // group that does not exist yet is asking for both, and making them close
  // the menu, find a settings page, and come back is the friction that stops
  // people from organizing anything at all.
  const createAndAssign = async () => {
    if (environmentId === null) return;
    const message = getGroupNameValidationMessage(newName, groups);
    if (message !== null) {
      setCreateError(message);
      return;
    }
    setCreateError(null);
    const created = await upsertGroup({
      environmentId,
      input: { name: newName.trim() as AdeBotGroup["name"] },
    });
    if (created._tag === "Failure") {
      setCreateError(
        adeCaptainErrorMessage(squashAtomCommandFailure(created), "The group was not created."),
      );
      return;
    }
    setNewName("");
    setCreating(false);
    await moveTo(created.value.id);
  };

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={trigger as never} />
      <MenuPopup align="start" className="min-w-56">
        <MenuGroupLabel>Group</MenuGroupLabel>
        {options.map((option) => (
          <MenuItem
            key={option.groupId ?? "ungrouped"}
            closeOnClick={false}
            disabled={assign.busy}
            onClick={() => void moveTo(option.groupId)}
          >
            <CheckIcon
              className={option.selected ? "size-4 shrink-0" : "size-4 shrink-0 opacity-0"}
            />
            <span className="min-w-0 truncate">{option.label}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        {creating ? (
          <div className="flex flex-col gap-2 p-2">
            <Input
              aria-label="New group name"
              autoFocus
              placeholder="Group name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createAndAssign();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCreating(false);
                }
              }}
            />
            {createError === null ? null : (
              <p className="text-xs text-destructive" role="alert">
                {createError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button disabled={assign.busy} size="sm" onClick={() => void createAndAssign()}>
                Create
              </Button>
            </div>
          </div>
        ) : (
          <MenuItem closeOnClick={false} onClick={() => setCreating(true)}>
            <FolderPlusIcon className="size-4 shrink-0" />
            <span>New group…</span>
          </MenuItem>
        )}
        {assign.error === null ? null : (
          <p className="px-2 pb-2 text-xs text-destructive" role="alert">
            {assign.error}
          </p>
        )}
      </MenuPopup>
    </Menu>
  );
}
