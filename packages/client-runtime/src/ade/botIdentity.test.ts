import { describe, expect, it } from "vite-plus/test";

import type { AdeBotGroup, AdeBotGroupId, Bot, BotId } from "@shuv2code/contracts";

import {
  BOT_AVATAR_COLORS,
  buildBotIdentityPatch,
  getBotIdentityDraft,
  getBotIdentityValidationMessage,
  getGroupAssignOptions,
  getGroupNameValidationMessage,
  groupIdFromMenuValue,
  groupMenuValue,
  isBotAvatarColor,
  openBotIdentitySheet,
  reconcileBotIdentitySheet,
  resolveBotAvatarColor,
  UNGROUPED_MENU_VALUE,
} from "./botIdentity.ts";

const bot = (overrides: Partial<Bot> = {}): Bot =>
  ({
    id: "bot-1" as BotId,
    name: "Code Monkey",
    displayMeta: null,
    structuralRole: "crew",
    roleTag: "Coder",
    projectId: null,
    groupId: null,
    activePersonaVersionId: null,
    computerUse: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  }) as Bot;

const group = (id: string, name: string, orderIndex: number): AdeBotGroup =>
  ({
    id: id as AdeBotGroupId,
    name,
    orderIndex,
    createdAt: "2026-08-24T00:00:00.000Z",
  }) as AdeBotGroup;

describe("buildBotIdentityPatch", () => {
  it("returns null when nothing moved", () => {
    const subject = bot();
    expect(buildBotIdentityPatch(subject, getBotIdentityDraft(subject))).toBeNull();
  });

  it("sends only what changed, so a stale field cannot clobber another surface", () => {
    const subject = bot({ displayMeta: { emoji: "🐒" } });
    const patch = buildBotIdentityPatch(subject, {
      ...getBotIdentityDraft(subject),
      name: "Wrench",
    });
    expect(patch).toEqual({ botId: subject.id, name: "Wrench" });
  });

  /**
   * The ticket's whole point: structural facts are server-owned. The patch is
   * built from a fixed key set, so there is no draft a captain can type that
   * puts `structuralRole` or template lineage on the wire.
   */
  it("never carries structuralRole or lineage in a write payload", () => {
    const subject = bot({ structuralRole: "firstmate", projectId: null });
    const patch = buildBotIdentityPatch(subject, {
      ...getBotIdentityDraft(subject),
      name: "Number One",
      emoji: "⚓",
      color: "blue",
      roleTag: "Coordinator",
      groupId: "group-1" as AdeBotGroupId,
    });

    expect(patch).not.toBeNull();
    expect(Object.keys(patch ?? {}).toSorted()).toEqual([
      "botId",
      "displayMeta",
      "groupId",
      "name",
      "roleTag",
    ]);
    for (const forbidden of [
      "structuralRole",
      "templateId",
      "projectId",
      "activePersonaVersionId",
      "createdAt",
      "archivedAt",
    ]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });

  /** Renaming the Firstmate is a normal patch — permanence is about existence. */
  it("builds a rename for the Firstmate like any other bot", () => {
    const firstmate = bot({ structuralRole: "firstmate", name: "Firstmate" });
    expect(
      buildBotIdentityPatch(firstmate, { ...getBotIdentityDraft(firstmate), name: "Number One" }),
    ).toEqual({ botId: firstmate.id, name: "Number One" });
  });

  it("clears decoration with an explicit null rather than an empty blob", () => {
    const subject = bot({ displayMeta: { emoji: "🐒", color: "amber" } });
    expect(
      buildBotIdentityPatch(subject, { ...getBotIdentityDraft(subject), emoji: "", color: "" }),
    ).toEqual({ botId: subject.id, displayMeta: null });
  });

  it("keeps a description the sheet never showed the captain", () => {
    const subject = bot({ displayMeta: { emoji: "🐒", description: "Ships fixes" } });
    expect(
      buildBotIdentityPatch(subject, { ...getBotIdentityDraft(subject), emoji: "🔧" }),
    ).toEqual({
      botId: subject.id,
      displayMeta: { emoji: "🔧", description: "Ships fixes" },
    });
  });

  it("moves a bot to Ungrouped with an explicit null", () => {
    const subject = bot({ groupId: "group-1" as AdeBotGroupId });
    expect(
      buildBotIdentityPatch(subject, { ...getBotIdentityDraft(subject), groupId: null }),
    ).toEqual({ botId: subject.id, groupId: null });
  });

  it("trims before comparing, so whitespace alone is not a change", () => {
    const subject = bot();
    expect(
      buildBotIdentityPatch(subject, { ...getBotIdentityDraft(subject), name: "  Code Monkey  " }),
    ).toBeNull();
  });
});

describe("getBotIdentityValidationMessage", () => {
  it("refuses an emptied name or role tag — the patch cannot clear either", () => {
    const draft = getBotIdentityDraft(bot());
    expect(getBotIdentityValidationMessage({ ...draft, name: "   " })).toBe("A bot needs a name.");
    expect(getBotIdentityValidationMessage({ ...draft, roleTag: "" })).toBe(
      "A bot needs a role tag.",
    );
  });

  it("mirrors the contract bounds before a round trip", () => {
    const draft = getBotIdentityDraft(bot());
    expect(getBotIdentityValidationMessage({ ...draft, name: "n".repeat(161) })).toMatch(/160/);
    expect(getBotIdentityValidationMessage({ ...draft, roleTag: "r".repeat(81) })).toMatch(/80/);
  });

  it("accepts a decorated, grouped, renamed bot", () => {
    expect(
      getBotIdentityValidationMessage({
        name: "Wrench",
        roleTag: "Fixer",
        emoji: "🔧",
        color: "amber",
        groupId: "group-1" as AdeBotGroupId,
      }),
    ).toBeNull();
  });
});

describe("getGroupAssignOptions", () => {
  const groups = [group("group-1", "Backend", 0), group("group-2", "Frontend", 1)];

  it("leads with Ungrouped, which every bot can always take", () => {
    const options = getGroupAssignOptions(groups, "group-2" as AdeBotGroupId);
    expect(options.map((option) => option.label)).toEqual(["Ungrouped", "Backend", "Frontend"]);
    expect(options.filter((option) => option.selected).map((option) => option.groupId)).toEqual([
      "group-2",
    ]);
  });

  it("selects Ungrouped when the bot is in no group", () => {
    expect(getGroupAssignOptions(groups, null)[0]).toEqual({
      groupId: null,
      label: "Ungrouped",
      selected: true,
    });
  });

  it("round-trips the null group through a menu value", () => {
    expect(groupMenuValue(null)).toBe(UNGROUPED_MENU_VALUE);
    expect(groupIdFromMenuValue(UNGROUPED_MENU_VALUE)).toBeNull();
    expect(groupIdFromMenuValue("group-1")).toBe("group-1");
  });
});

describe("getGroupNameValidationMessage", () => {
  const groups = [group("group-1", "Backend", 0)];

  it("catches the duplicate the server would refuse anyway", () => {
    expect(getGroupNameValidationMessage("backend", groups)).toMatch(/already exists/);
  });

  it("requires a name and bounds it", () => {
    expect(getGroupNameValidationMessage("  ", groups)).toBe("A group needs a name.");
    expect(getGroupNameValidationMessage("g".repeat(81), groups)).toMatch(/80/);
  });

  it("accepts a fresh name", () => {
    expect(getGroupNameValidationMessage(" Frontend ", groups)).toBeNull();
  });
});

/**
 * The sheet must not eat a captain's typing when the bot prop changes — which
 * it does on the 15s roster poll and on every sibling control's re-read.
 */
describe("reconcileBotIdentitySheet", () => {
  it("adopts the server's copy while the draft is untouched", () => {
    const state = openBotIdentitySheet(bot());
    const next = reconcileBotIdentitySheet(state, bot({ name: "Renamed elsewhere" }));

    expect(next.draft.name).toBe("Renamed elsewhere");
    expect(next.changedElsewhere).toBe(false);
  });

  /**
   * The reported defect, verbatim: flipping computer use inside the sheet
   * re-reads the bot, and the half-typed name used to vanish. Computer use is
   * not part of the draft, so the identity fields are byte-identical and the
   * draft must simply survive.
   */
  it("keeps a half-typed name when a sibling control re-reads the bot", () => {
    const subject = bot();
    let state = openBotIdentitySheet(subject);
    state = { ...state, draft: { ...state.draft, name: "Wrenc" } };

    const next = reconcileBotIdentitySheet(state, bot({ computerUse: true }));

    expect(next.draft.name).toBe("Wrenc");
    // Nothing the sheet edits moved, so there is nothing to warn about.
    expect(next.changedElsewhere).toBe(false);
  });

  it("keeps a dirty draft and flags a real change from elsewhere", () => {
    const subject = bot();
    let state = openBotIdentitySheet(subject);
    state = { ...state, draft: { ...state.draft, name: "Wrenc" } };

    const next = reconcileBotIdentitySheet(state, bot({ name: "Renamed elsewhere" }));

    expect(next.draft.name).toBe("Wrenc");
    expect(next.changedElsewhere).toBe(true);
  });

  it("does not re-flag the same change on every later poll", () => {
    const subject = bot();
    let state = openBotIdentitySheet(subject);
    state = { ...state, draft: { ...state.draft, name: "Wrenc" } };
    const moved = bot({ name: "Renamed elsewhere" });

    const flagged = reconcileBotIdentitySheet(state, moved);
    const again = reconcileBotIdentitySheet({ ...flagged, changedElsewhere: false }, moved);

    expect(flagged.changedElsewhere).toBe(true);
    // `seededFrom` moved with the server, so the next tick is a no-op.
    expect(again.changedElsewhere).toBe(false);
    expect(again.draft.name).toBe("Wrenc");
  });

  it("re-adopts the server on the next open", () => {
    const subject = bot();
    let state = openBotIdentitySheet(subject);
    state = { ...state, draft: { ...state.draft, name: "Abandoned" } };

    expect(openBotIdentitySheet(bot({ name: "Server truth" })).draft.name).toBe("Server truth");
  });
});

/**
 * A token is not a CSS color. Every surface that paints a bot has to go
 * through one resolver or three of the ten swatches render invisible.
 */
describe("resolveBotAvatarColor", () => {
  it("resolves every offered token to a theme variable", () => {
    for (const token of BOT_AVATAR_COLORS) {
      expect(resolveBotAvatarColor(token)).toBe(`var(--color-${token}-500)`);
    }
  });

  it("refuses anything outside the palette rather than painting it raw", () => {
    for (const value of ["", "#ff0000", "chartreuse", "red; background: url(x)"]) {
      expect(resolveBotAvatarColor(value)).toBeNull();
      expect(isBotAvatarColor(value)).toBe(false);
    }
    expect(resolveBotAvatarColor(null)).toBeNull();
    expect(resolveBotAvatarColor(undefined)).toBeNull();
  });
});

describe("bounds on captain-authored decoration", () => {
  it("refuses an over-long emoji before the round trip", () => {
    const draft = getBotIdentityDraft(bot());
    expect(getBotIdentityValidationMessage({ ...draft, emoji: "🤖".repeat(20) })).toMatch(/32/);
  });

  it("refuses control characters in the emoji", () => {
    const draft = getBotIdentityDraft(bot());
    for (const hostile of ["a\u0000b", "a\nb", "a\u202eb"]) {
      expect(getBotIdentityValidationMessage({ ...draft, emoji: hostile })).toMatch(
        /cannot be displayed/,
      );
    }
  });

  it("refuses a color that is not in the palette", () => {
    const draft = getBotIdentityDraft(bot());
    expect(getBotIdentityValidationMessage({ ...draft, color: "chartreuse" })).toMatch(/palette/);
    expect(getBotIdentityValidationMessage({ ...draft, color: "amber" })).toBeNull();
  });

  it("drops an unpaintable stored color instead of carrying it forward", () => {
    const subject = bot({ displayMeta: { emoji: "🐒" } });
    const patch = buildBotIdentityPatch(subject, {
      ...getBotIdentityDraft(subject),
      color: "amber",
    });
    expect(patch).toEqual({ botId: subject.id, displayMeta: { emoji: "🐒", color: "amber" } });
  });

  it("clears the color with the picker's None swatch", () => {
    const subject = bot({ displayMeta: { emoji: "🐒", color: "amber" } });
    expect(buildBotIdentityPatch(subject, { ...getBotIdentityDraft(subject), color: "" })).toEqual({
      botId: subject.id,
      displayMeta: { emoji: "🐒" },
    });
  });
});
