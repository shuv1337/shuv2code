/**
 * Pure logic for the bot identity sheet (`docs/ade/MESSENGER-PIVOT.md` §3,
 * ticket T2 / #197).
 *
 * The sheet edits a *label* — name, emoji, color, role tag, group. Everything
 * structural about a bot (its `structuralRole`, the template it came from) is
 * server-owned, and the shape of the patch this module builds is where that
 * line is drawn on the client: `buildBotIdentityPatch` returns exactly the
 * five keys `AdeUpdateBotIdentityInput` accepts, so a structural field cannot
 * be smuggled into a save even by accident.
 */
import type {
  AdeBotGroup,
  AdeBotGroupId,
  AdeUpdateBotIdentityInput,
  Bot,
  BotDisplayMeta,
  BotName,
  BotRoleTag,
} from "@shuv2code/contracts";

/**
 * The palette offered for a bot's avatar blob. Names, not hex: they are the
 * keys `components/color-selector` maps onto theme variables, so a bot keeps
 * a sensible contrast in light and dark rather than one baked-in swatch.
 */
export const BOT_AVATAR_COLORS = [
  "blue",
  "teal",
  "emerald",
  "lime",
  "amber",
  "orange",
  "rose",
  "fuchsia",
  "violet",
  "indigo",
] as const;

export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

/** Mirrors `BotName` / `BotRoleTag` in contracts so the sheet can say no first. */
export const BOT_NAME_MAX_LENGTH = 160;
export const BOT_ROLE_TAG_MAX_LENGTH = 80;
export const BOT_GROUP_NAME_MAX_LENGTH = 80;

/** The editable surface of a bot, as the sheet holds it while typing. */
export interface BotIdentityDraft {
  readonly name: string;
  readonly roleTag: string;
  readonly emoji: string;
  readonly color: string;
  readonly groupId: AdeBotGroupId | null;
}

/**
 * Seed a draft from the server's copy.
 *
 * Blank strings rather than `undefined` for the optional decoration: the form
 * controls are always mounted, and an input whose value flips between
 * controlled and uncontrolled is a React warning waiting to happen.
 */
export function getBotIdentityDraft(bot: Bot): BotIdentityDraft {
  return {
    name: bot.name,
    roleTag: bot.roleTag,
    emoji: bot.displayMeta?.emoji ?? "",
    color: bot.displayMeta?.color ?? "",
    groupId: bot.groupId,
  };
}

/**
 * Why the sheet cannot be saved, or null when it can.
 *
 * A bot always has a name and a role tag — the patch has no way to clear
 * either — so an emptied field is a validation failure rather than a clear.
 */
export function getBotIdentityValidationMessage(draft: BotIdentityDraft): string | null {
  const name = draft.name.trim();
  if (name.length === 0) return "A bot needs a name.";
  if (name.length > BOT_NAME_MAX_LENGTH) {
    return `Names are at most ${BOT_NAME_MAX_LENGTH} characters.`;
  }
  const roleTag = draft.roleTag.trim();
  if (roleTag.length === 0) return "A bot needs a role tag.";
  if (roleTag.length > BOT_ROLE_TAG_MAX_LENGTH) {
    return `Role tags are at most ${BOT_ROLE_TAG_MAX_LENGTH} characters.`;
  }
  return null;
}

const displayMetaOf = (draft: BotIdentityDraft, bot: Bot): BotDisplayMeta | null => {
  const emoji = draft.emoji.trim();
  const color = draft.color.trim();
  // `description` is not edited here, but it is part of the same blob and the
  // patch replaces the blob wholesale — dropping it would silently delete a
  // field this sheet never showed the captain.
  const description = bot.displayMeta?.description;
  if (emoji.length === 0 && color.length === 0 && description === undefined) return null;
  return {
    ...(emoji.length === 0 ? {} : { emoji }),
    ...(color.length === 0 ? {} : { color }),
    ...(description === undefined ? {} : { description }),
  };
};

const sameDisplayMeta = (left: BotDisplayMeta | null, right: BotDisplayMeta | null): boolean => {
  if (left === null || right === null) return left === right;
  return (
    left.emoji === right.emoji &&
    left.color === right.color &&
    left.description === right.description
  );
};

/**
 * The minimal patch that turns the server's bot into the draft, or null when
 * nothing moved.
 *
 * Minimal on purpose: `undefined` means "leave it alone" on the wire, so a
 * sheet that only changed the emoji sends only the emoji and cannot clobber a
 * rename that landed from another surface in between.
 */
export function buildBotIdentityPatch(
  bot: Bot,
  draft: BotIdentityDraft,
): AdeUpdateBotIdentityInput | null {
  const name = draft.name.trim();
  const roleTag = draft.roleTag.trim();
  const displayMeta = displayMetaOf(draft, bot);

  const patch: {
    -readonly [K in keyof AdeUpdateBotIdentityInput]: AdeUpdateBotIdentityInput[K];
  } = { botId: bot.id };
  let changed = false;

  if (name !== bot.name) {
    patch.name = name as BotName;
    changed = true;
  }
  if (roleTag !== bot.roleTag) {
    patch.roleTag = roleTag as BotRoleTag;
    changed = true;
  }
  if (!sameDisplayMeta(displayMeta, bot.displayMeta)) {
    patch.displayMeta = displayMeta;
    changed = true;
  }
  if (draft.groupId !== bot.groupId) {
    patch.groupId = draft.groupId;
    changed = true;
  }

  return changed ? patch : null;
}

/** One row of the group-assignment menu. */
export interface GroupAssignOption {
  /** `null` is the trailing Ungrouped bucket, which is an absence, not a row. */
  readonly groupId: AdeBotGroupId | null;
  readonly label: string;
  readonly selected: boolean;
}

/**
 * The menu-first path to group assignment (messenger pivot §2: drag is an
 * affordance, not the accessible path).
 *
 * Ungrouped leads rather than trails here: it is the only option every bot can
 * always take, and putting the escape hatch first means a captain who opened
 * the menu to get a bot *out* of a group does not have to read the whole list.
 */
export function getGroupAssignOptions(
  groups: ReadonlyArray<AdeBotGroup>,
  currentGroupId: AdeBotGroupId | null,
): ReadonlyArray<GroupAssignOption> {
  return [
    { groupId: null, label: "Ungrouped", selected: currentGroupId === null },
    ...groups.map((group) => ({
      groupId: group.id,
      label: group.name,
      selected: group.id === currentGroupId,
    })),
  ];
}

/** Menu radio values are strings; `null` needs a spelling that is not an id. */
export const UNGROUPED_MENU_VALUE = "__ungrouped__";

export function groupMenuValue(groupId: AdeBotGroupId | null): string {
  return groupId ?? UNGROUPED_MENU_VALUE;
}

export function groupIdFromMenuValue(value: string): AdeBotGroupId | null {
  return value === UNGROUPED_MENU_VALUE ? null : (value as AdeBotGroupId);
}

/** Why a new group cannot be created yet, or null when it can. */
export function getGroupNameValidationMessage(
  name: string,
  groups: ReadonlyArray<AdeBotGroup>,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A group needs a name.";
  if (trimmed.length > BOT_GROUP_NAME_MAX_LENGTH) {
    return `Group names are at most ${BOT_GROUP_NAME_MAX_LENGTH} characters.`;
  }
  // Caught server-side too; saying it here saves a round trip and a rail that
  // briefly renders two identical headers.
  if (groups.some((group) => group.name.toLowerCase() === trimmed.toLowerCase())) {
    return `A group named “${trimmed}” already exists.`;
  }
  return null;
}
