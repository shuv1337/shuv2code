/**
 * Menu-first group assignment (`docs/ade/MESSENGER-PIVOT.md` §2, §3 — M2/#197).
 *
 * Drag-and-drop is the affordance a captain reaches for once they know the
 * rail; this menu is the path that always works — keyboard, touch, screen
 * reader, and the very first time. It is a standalone component so the shell
 * (M1) can mount it from a contact row's context menu and the identity sheet
 * can mount the same control, without either owning the other.
 */
import type { AdeBotGroup, AdeBotGroupId, Bot } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { FolderPlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  buildBotIdentityPatch,
  getBotIdentityDraft,
  getGroupAssignOptions,
  getGroupNameValidationMessage,
  groupIdFromMenuValue,
  groupMenuValue,
  type GroupAssignOption,
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
        <GroupAssignMenuContent
          assignError={assign.error}
          busy={assign.busy}
          createError={createError}
          creating={creating}
          newName={newName}
          options={options}
          selectedValue={groupMenuValue(bot.groupId)}
          onCancelCreate={() => setCreating(false)}
          onCreate={() => void createAndAssign()}
          onNewNameChange={setNewName}
          onSelect={(value) => void moveTo(groupIdFromMenuValue(value))}
          onStartCreate={() => setCreating(true)}
        />
      </MenuPopup>
    </Menu>
  );
}

/**
 * Everything inside the popup, as a function of props.
 *
 * Split out so the composition can be rendered — and therefore tested —
 * without a menu trigger, a portal, or an atom registry. That matters more
 * here than it looks: the bug this shape exists to stop was a *render-time*
 * Base UI invariant ("MenuGroupContext is missing"), which took the whole page
 * into the error boundary the first time a captain clicked the group button
 * and which no amount of testing the surrounding pure logic could see.
 */
export function GroupAssignMenuContent({
  assignError,
  busy,
  createError,
  creating,
  newName,
  options,
  selectedValue,
  onCancelCreate,
  onCreate,
  onNewNameChange,
  onSelect,
  onStartCreate,
}: {
  readonly assignError: string | null;
  readonly busy: boolean;
  readonly createError: string | null;
  readonly creating: boolean;
  readonly newName: string;
  readonly options: ReadonlyArray<GroupAssignOption>;
  readonly selectedValue: string;
  readonly onCancelCreate: () => void;
  readonly onCreate: () => void;
  readonly onNewNameChange: (next: string) => void;
  readonly onSelect: (value: string) => void;
  readonly onStartCreate: () => void;
}) {
  return (
    <>
      {/*
       * A radio group, not a bare run of items with a hand-drawn check.
       *
       * Two reasons, and the first one is a crash: Base UI's `GroupLabel`
       * reads a context only `Menu.Group` / `Menu.RadioGroup` provide, so
       * labelling a bare run of items threw "MenuGroupContext is missing" and
       * took the page into the error boundary. The second is that this
       * genuinely *is* a single select — a bot is in one group or none — so
       * the radio parts hand a screen reader real roles and checked state
       * instead of an icon that only looks like a selection to someone who can
       * see it.
       */}
      <MenuRadioGroup value={selectedValue} onValueChange={(value) => onSelect(String(value))}>
        <MenuGroupLabel>Group</MenuGroupLabel>
        {options.map((option) => (
          <MenuRadioItem
            key={option.groupId ?? "ungrouped"}
            closeOnClick={false}
            disabled={busy}
            value={groupMenuValue(option.groupId)}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      {creating ? (
        <div className="flex flex-col gap-2 p-2">
          <Input
            aria-label="New group name"
            autoFocus
            placeholder="Group name"
            value={newName}
            onChange={(event) => onNewNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCreate();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelCreate();
              }
              // Base UI menus type-ahead on printable keys, which would steal
              // every character typed into this field and jump the highlight
              // to a group instead. The field is inside the menu, so the menu
              // must be told these keys are already spoken for.
              event.stopPropagation();
            }}
          />
          {createError === null ? null : (
            <p className="text-xs text-destructive" role="alert">
              {createError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancelCreate}>
              Cancel
            </Button>
            <Button disabled={busy} size="sm" onClick={onCreate}>
              Create
            </Button>
          </div>
        </div>
      ) : (
        <MenuItem closeOnClick={false} onClick={onStartCreate}>
          <FolderPlusIcon className="size-4 shrink-0" />
          <span>New group…</span>
        </MenuItem>
      )}
      {assignError === null ? null : (
        <p className="px-2 pb-2 text-xs text-destructive" role="alert">
          {assignError}
        </p>
      )}
    </>
  );
}
