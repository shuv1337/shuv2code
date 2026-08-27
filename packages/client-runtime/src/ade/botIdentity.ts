/**
 * Pure logic for the bot identity sheet (`docs/ade/MESSENGER-PIVOT.md` §3,
 * ticket M2 / #197).
 *
 * The sheet edits a *label* — name, emoji, color, role tag, group. Everything
 * structural about a bot (its `structuralRole`, the template it came from) is
 * server-owned, and the shape of the patch this module builds is where that
 * line is drawn on the client: `buildBotIdentityPatch` returns exactly the
 * five keys `AdeUpdateBotIdentityInput` accepts, so a structural field cannot
 * be smuggled into a save even by accident.
 */
import {
  BotAvatarColorToken,
  type AdeBotGroup,
  type AdeBotGroupId,
  type AdeUpdateBotIdentityInput,
  type Bot,
  type BotDisplayMeta,
  type BotName,
  type BotRoleTag,
} from "@shuv2code/contracts";

/**
 * The palette offered for a bot's avatar blob, straight off the contract so
 * the picker and the schema cannot drift into offering a token the server
 * would refuse.
 */
export const BOT_AVATAR_COLORS: ReadonlyArray<BotAvatarColorToken> = BotAvatarColorToken.literals;

export type BotAvatarColor = BotAvatarColorToken;

/**
 * Resolve an avatar token to something CSS can actually paint.
 *
 * **This is the only place a token becomes a color.** It lives here rather
 * than inside the picker because every surface that draws a bot needs the same
 * answer — the rail row, the conversation header, the attribution line, the
 * avatar blob. A token applied raw as `backgroundColor` is invisible for
 * `emerald`/`fuchsia`/`lime` (not CSS named colors at all) and wrong for the
 * rest (the untuned named color, not the theme's). Callers outside this module
 * — including `BotAvatar` — must go through this function.
 *
 * Null in, null out: an unset color means "fall back to the deterministic hue
 * derived from the bot id", which is the caller's business, not this one's.
 */
export function resolveBotAvatarColor(token: string | null | undefined): string | null {
  if (token === null || token === undefined) return null;
  return isBotAvatarColor(token) ? `var(--color-${token}-500)` : null;
}

/** A stored color that is no longer in the palette must not be painted. */
export function isBotAvatarColor(value: string): value is BotAvatarColorToken {
  return (BOT_AVATAR_COLORS as ReadonlyArray<string>).includes(value);
}

/** Mirrors the contract bounds so the sheet can say no before a round trip. */
export const BOT_NAME_MAX_LENGTH = 160;
export const BOT_ROLE_TAG_MAX_LENGTH = 80;
export const BOT_GROUP_NAME_MAX_LENGTH = 80;
export const BOT_EMOJI_MAX_LENGTH = 32;

/**
 * What the sheet says under the role-tag field.
 *
 * The tag is not only decoration: the integration service picks a project's
 * reviewer by looking for the word "reviewer" in it (ADR §7.2,
 * `AdeIntegrationService.resolveReviewer`), so relabelling a bot silently
 * re-routes review work in both directions. #197 keeps the field writable on
 * purpose — a reserved word the captain may not type is exactly the strictness
 * this ticket removes — so the consequence is disclosed instead of prevented.
 */
export const ROLE_TAG_ROUTING_HINT = "Tags containing “Reviewer” receive review work.";

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

export function sameBotIdentityDraft(left: BotIdentityDraft, right: BotIdentityDraft): boolean {
  return (
    left.name === right.name &&
    left.roleTag === right.roleTag &&
    left.emoji === right.emoji &&
    left.color === right.color &&
    left.groupId === right.groupId
  );
}

/**
 * What the sheet holds while it is open.
 *
 * `seededFrom` is the server snapshot the draft was last taken from. It is the
 * whole reason this is a state machine rather than a `useEffect` that copies
 * the latest bot into the form: the roster polls every 15 seconds and every
 * sibling control (computer use, group assign) re-reads the bot, so "the bot
 * prop changed" says nothing about whether the captain's typing is stale.
 * Comparing against `seededFrom` does.
 */
export interface BotIdentitySheetState {
  readonly draft: BotIdentityDraft;
  readonly seededFrom: BotIdentityDraft;
  /** True once a server-side change was refused adoption to protect a dirty draft. */
  readonly changedElsewhere: boolean;
}

/** Opening the sheet always adopts the server's copy — nothing is in flight yet. */
export function openBotIdentitySheet(bot: Bot): BotIdentitySheetState {
  const draft = getBotIdentityDraft(bot);
  return { draft, seededFrom: draft, changedElsewhere: false };
}

/**
 * Fold a fresh server copy into an open sheet.
 *
 * Three cases, and the middle one is the defect this function exists to fix:
 *
 * - **Pristine draft** — the captain has typed nothing since the last seed, so
 *   adopt the server's copy silently. A poll should keep an untouched form
 *   current.
 * - **Dirty draft, server moved** — keep every character the captain typed and
 *   raise `changedElsewhere`. Discarding their work to make room for an
 *   explanation of why it was discarded is the worst of both.
 * - **Dirty draft, server unchanged** — the common case on every poll tick:
 *   change nothing, and in particular do not raise the notice, or a rename in
 *   progress would sprout a warning about itself.
 */
export function reconcileBotIdentitySheet(
  state: BotIdentitySheetState,
  bot: Bot,
): BotIdentitySheetState {
  const server = getBotIdentityDraft(bot);
  if (sameBotIdentityDraft(server, state.seededFrom)) return state;
  if (sameBotIdentityDraft(state.draft, state.seededFrom)) {
    return { draft: server, seededFrom: server, changedElsewhere: false };
  }
  // Re-seat `seededFrom` on the server's new copy even though the draft stays:
  // the next comparison must be against what the server holds now, or one
  // change elsewhere would make every later poll look like a fresh one.
  return { draft: state.draft, seededFrom: server, changedElsewhere: true };
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
  const emoji = draft.emoji.trim();
  if (emoji.length > BOT_EMOJI_MAX_LENGTH) {
    return `Emoji are at most ${BOT_EMOJI_MAX_LENGTH} characters.`;
  }
  // The server refuses these outright (they are a layout exploit against the
  // rail, the header, and the avatar at once). Saying so here turns a rejected
  // save into a message beside the field that caused it.
  if (emoji.length > 0 && CONTROL_CHARACTERS.test(emoji)) {
    return "That emoji contains characters that cannot be displayed.";
  }
  // A stored token that has since left the palette is not paintable; refusing
  // to re-save it is how it gets replaced rather than carried forward.
  if (draft.color.length > 0 && !isBotAvatarColor(draft.color)) {
    return "Pick a color from the palette.";
  }
  return null;
}

/** Mirrors the contract's control-character refusal. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

const displayMetaOf = (draft: BotIdentityDraft, bot: Bot): BotDisplayMeta | null => {
  const emoji = draft.emoji.trim();
  const color = draft.color.trim();
  // `description` is not edited here, but it is part of the same blob and the
  // patch replaces the blob wholesale — dropping it would silently delete a
  // field this sheet never showed the captain.
  const description = bot.displayMeta?.description;
  if (emoji.length === 0 && !isBotAvatarColor(color) && description === undefined) return null;
  return {
    ...(emoji.length === 0 ? {} : { emoji }),
    ...(isBotAvatarColor(color) ? { color } : {}),
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
