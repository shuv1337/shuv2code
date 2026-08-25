import type {
  AdeBotGroup,
  AdeBotGroupId,
  AdeRoster,
  AdeRosterEntry,
  Bot,
  BotDisplayMeta,
  BotId,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  UNGROUPED_SECTION_ID,
  UNGROUPED_SECTION_NAME,
  UNREAD_DISPLAY_CAP,
  applyContactRailFilter,
  parseContactRailFilter,
  resolveSecondaryLine,
  unreadAnnouncement,
  unreadBadgeLabel,
  botAvatarHue,
  botAvatarInitials,
  contactRailEmptyCopy,
  filterContactRows,
  getBotAvatarView,
  getContactGroupSections,
  getContactRowView,
  getContactRowViews,
  resolveBotAvatarBackground,
  rosterNeedsFirstProject,
  shouldShowFirstProjectCtaInRail,
  templateOptionLabel,
} from "./contactRail.logic";

const BACKEND = "group_backend" as AdeBotGroupId;
const FRONTEND = "group_frontend" as AdeBotGroupId;

function group(id: AdeBotGroupId, name: string, orderIndex: number): AdeBotGroup {
  return { id, name, orderIndex, createdAt: "2026-08-24T00:00:00.000Z" } as AdeBotGroup;
}

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot_1" as BotId,
    name: "Firstmate",
    displayMeta: null,
    structuralRole: "firstmate",
    roleTag: "Coordinator",
    projectId: null,
    activePersonaVersionId: null,
    computerUse: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  } as Bot;
}

function entry(overrides: Partial<AdeRosterEntry> = {}): AdeRosterEntry {
  return {
    bot: bot(),
    projectName: null,
    hasActivePrimarySession: false,
    openAssignmentCount: 0,
    // M3's liveness fields, at their "nothing has happened yet" values. Spelled
    // out rather than left off so the fixture matches what a decoded payload
    // actually looks like — the schema defaults these, and a fixture that
    // omitted them would be testing a shape no server sends.
    lastMessage: null,
    attention: null,
    unreadCount: 0,
    ...overrides,
  } as AdeRosterEntry;
}

// ---------------------------------------------------------------------------
// Absorbed from `fleet/FleetRosterPage.logic.test.ts` (M1: the rail replaces
// the roster page, so the roster page's contract has to keep holding here).
// ---------------------------------------------------------------------------

describe("getContactRowView", () => {
  it("marks the Firstmate and names a fleet-wide bot's home", () => {
    const view = getContactRowView(entry());
    expect(view.isFirstmate).toBe(true);
    expect(view.roleLabel).toBe("Firstmate");
    expect(view.projectLabel).toBe("Fleet-wide");
    expect(view.openAssignmentLabel).toBeNull();
    expect(view.chatLabel).toBe("Chat");
  });

  it("resumes rather than starts when a primary session is already warm", () => {
    expect(getContactRowView(entry({ hasActivePrimarySession: true })).chatLabel).toBe(
      "Resume chat",
    );
  });

  it("reports the warm session as visible presence, not only as button wording", () => {
    const idle = getContactRowView(entry());
    expect(idle.isOnline).toBe(false);
    expect(idle.presenceLabel).toBe("No session");

    const warm = getContactRowView(entry({ hasActivePrimarySession: true }));
    expect(warm.isOnline).toBe(true);
    expect(warm.presenceLabel).toBe("Session active");
  });

  it("counts open assignments in words the row can print", () => {
    expect(getContactRowView(entry({ openAssignmentCount: 1 })).openAssignmentLabel).toBe(
      "1 open assignment",
    );
    expect(getContactRowView(entry({ openAssignmentCount: 4 })).openAssignmentLabel).toBe(
      "4 open assignments",
    );
  });

  it("uses the project name when the bot has a home", () => {
    const view = getContactRowView(
      entry({ bot: bot({ structuralRole: "crew", roleTag: "Coder" }), projectName: "shuv2code" }),
    );
    expect(view.projectLabel).toBe("shuv2code");
    expect(view.roleLabel).toBe("Crew");
    expect(view.isFirstmate).toBe(false);
  });

  it("folds home and open assignments into the row's single dim line", () => {
    expect(getContactRowView(entry({ projectName: "shuv2code" })).secondaryLine).toBe("shuv2code");
    expect(
      getContactRowView(entry({ projectName: "shuv2code", openAssignmentCount: 2 })).secondaryLine,
    ).toBe("shuv2code · 2 open assignments");
  });
});

describe("getContactRowViews", () => {
  it("preserves the server's order and reads nothing before the roster answers", () => {
    expect(getContactRowViews(null)).toEqual([]);
    const roster = {
      entries: [entry(), entry({ bot: bot({ id: "bot_2" as BotId, name: "Coder" }) })],
      projects: [],
      templates: [],
    } as unknown as AdeRoster;
    expect(getContactRowViews(roster).map((row) => row.name)).toEqual(["Firstmate", "Coder"]);
  });
});

describe("rosterNeedsFirstProject", () => {
  it("stays quiet until the roster has answered", () => {
    expect(rosterNeedsFirstProject(null)).toBe(false);
  });

  it("asks for a first project only when there is none", () => {
    expect(
      rosterNeedsFirstProject({ entries: [], projects: [], templates: [] } as unknown as AdeRoster),
    ).toBe(true);
    expect(
      rosterNeedsFirstProject({
        entries: [],
        projects: [{ id: "prj_1", name: "shuv2code" }],
        templates: [],
      } as unknown as AdeRoster),
    ).toBe(false);
  });
});

describe("templateOptionLabel", () => {
  it("prints the name alone when the role tag repeats it", () => {
    expect(
      templateOptionLabel({ templateId: "coder", defaultName: "Coder", roleTag: "Coder" } as never),
    ).toBe("Coder");
  });

  it("prints both when they differ", () => {
    expect(
      templateOptionLabel({
        templateId: "researcher",
        defaultName: "Scout",
        roleTag: "Researcher",
      } as never),
    ).toBe("Scout · Researcher");
  });
});

// ---------------------------------------------------------------------------
// New to the rail.
// ---------------------------------------------------------------------------

describe("botAvatarHue", () => {
  it("is deterministic", () => {
    expect(botAvatarHue("bot_1")).toBe(botAvatarHue("bot_1"));
  });

  it("stays inside the hue circle", () => {
    for (const id of ["", "bot_1", "bot_2", "🙂", "a".repeat(200)]) {
      const hue = botAvatarHue(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("separates ids that differ only in their last character", () => {
    // Exactly the shape a roster produces; a char-code sum would collide here.
    const hues = new Set(["bot_1", "bot_2", "bot_3", "bot_4"].map(botAvatarHue));
    expect(hues.size).toBe(4);
  });
});

describe("botAvatarInitials", () => {
  it("takes the first letter of the first and last word", () => {
    expect(botAvatarInitials("Second Mate")).toBe("SM");
    expect(botAvatarInitials("Firstmate")).toBe("F");
    expect(botAvatarInitials("  code   monkey  ")).toBe("CM");
  });

  it("prints something rather than nothing for a nameless bot", () => {
    expect(botAvatarInitials("")).toBe("?");
    expect(botAvatarInitials("   ")).toBe("?");
  });

  it("does not split an astral glyph in half", () => {
    expect(botAvatarInitials("🚢 Fleet")).toBe("🚢F");
  });
});

/**
 * `BotDisplayMeta.color` is a closed token union since M2 (#197), but the
 * column predates it and `parseDisplayMeta` is deliberately lenient, so the
 * resolver still has to answer for a hex, a blank, or a word that is neither.
 * This cast is how those cases stay reachable from a test without widening the
 * contract they exist to defend against.
 */
function legacyMeta(meta: { emoji?: string; color?: string }): BotDisplayMeta {
  return meta as BotDisplayMeta;
}

describe("getBotAvatarView", () => {
  it("prefers the captain's emoji and colour when display meta carries them", () => {
    const view = getBotAvatarView({
      botId: "bot_1",
      name: "Coder",
      displayMeta: legacyMeta({ emoji: "🐒", color: "#ff8800" }),
    });
    expect(view.emoji).toBe("🐒");
    expect(view.color).toBe("#ff8800");
    expect(view.initials).toBe("C");
  });

  it("falls back to initials on a deterministic hue when there is no meta", () => {
    const view = getBotAvatarView({ botId: "bot_9", name: "Code Monkey", displayMeta: null });
    expect(view.emoji).toBeNull();
    expect(view.color).toBeNull();
    expect(view.initials).toBe("CM");
    expect(view.hue).toBe(botAvatarHue("bot_9"));
  });

  it("treats a blank meta field as unset rather than as an empty blob", () => {
    const view = getBotAvatarView({
      botId: "bot_1",
      name: "Coder",
      displayMeta: legacyMeta({ emoji: "   ", color: "" }),
    });
    expect(view.emoji).toBeNull();
    expect(view.color).toBeNull();
  });
});

describe("resolveBotAvatarBackground", () => {
  const avatar = (color: string | null) =>
    getBotAvatarView({
      botId: "bot_1",
      name: "Coder",
      displayMeta: color === null ? null : legacyMeta({ color }),
    });

  it("uses a real CSS colour when the captain picked one", () => {
    expect(resolveBotAvatarBackground(avatar("#ff8800"))).toBe("#ff8800");
    expect(resolveBotAvatarBackground(avatar("rgb(1 2 3)"))).toBe("rgb(1 2 3)");
    expect(resolveBotAvatarBackground(avatar("var(--color-amber-500)"))).toBe(
      "var(--color-amber-500)",
    );
  });

  it("falls back to the deterministic hue when no colour is set", () => {
    expect(resolveBotAvatarBackground(avatar(null))).toBe(`hsl(${botAvatarHue("bot_1")} 62% 42%)`);
  });

  /**
   * M2 (#197) stores theme *token names*, which `background-color` does not
   * understand — painting "amber" raw makes the blob invisible. The seam now
   * delegates to `resolveBotAvatarColor`, so the token becomes the theme
   * variable rather than the fallback hue.
   */
  it("resolves a stored theme token through the shared resolver", () => {
    expect(resolveBotAvatarBackground(avatar("amber"))).toBe("var(--color-amber-500)");
    expect(resolveBotAvatarBackground(avatar("emerald"))).toBe("var(--color-emerald-500)");
  });

  it("never renders a transparent blob for an unresolvable colour", () => {
    // Neither a palette token nor a CSS literal: the hue is the only honest
    // answer, and it is never `transparent`.
    for (const token of ["", "   ", "not-a-colour", "chartreuse", "AMBER"]) {
      const background = resolveBotAvatarBackground(avatar(token));
      expect(background).toBe(`hsl(${botAvatarHue("bot_1")} 62% 42%)`);
      expect(background).not.toBe("transparent");
    }
  });
});

describe("shouldShowFirstProjectCtaInRail", () => {
  it("stays out of the rail whenever the conversation region can host it", () => {
    expect(
      shouldShowFirstProjectCtaInRail({
        needsFirstProject: true,
        showCenter: true,
        railCollapsed: false,
      }),
    ).toBe(false);
  });

  it("moves into the rail when there is no conversation region at all", () => {
    // Single-column at the index route: the rail is the only surface, so the
    // #141 CTA has to live there or it does not exist at that width.
    expect(
      shouldShowFirstProjectCtaInRail({
        needsFirstProject: true,
        showCenter: false,
        railCollapsed: false,
      }),
    ).toBe(true);
  });

  it("says nothing when there is already a project", () => {
    expect(
      shouldShowFirstProjectCtaInRail({
        needsFirstProject: false,
        showCenter: false,
        railCollapsed: false,
      }),
    ).toBe(false);
  });

  it("does not try to fit a form into the 64px strip", () => {
    expect(
      shouldShowFirstProjectCtaInRail({
        needsFirstProject: true,
        showCenter: false,
        railCollapsed: true,
      }),
    ).toBe(false);
  });
});

describe("filterContactRows", () => {
  const rows = getContactRowViews({
    entries: [
      entry(),
      entry({ bot: bot({ id: "bot_2" as BotId, name: "Code Monkey", roleTag: "Coder" }) }),
      entry({ bot: bot({ id: "bot_3" as BotId, name: "Scout", roleTag: "Researcher" }) }),
    ],
    projects: [],
    templates: [],
  } as unknown as AdeRoster);

  it("returns the roster intact for an empty or whitespace query", () => {
    expect(filterContactRows(rows, "")).toEqual(rows);
    expect(filterContactRows(rows, "   ")).toEqual(rows);
  });

  it("matches names case-insensitively on a substring", () => {
    expect(filterContactRows(rows, "monk").map((row) => row.name)).toEqual(["Code Monkey"]);
    expect(filterContactRows(rows, "SCOUT").map((row) => row.name)).toEqual(["Scout"]);
  });

  it("also matches the role tag, so a renamed bot is still findable by role", () => {
    expect(filterContactRows(rows, "research").map((row) => row.name)).toEqual(["Scout"]);
  });

  it("preserves the server's order among matches", () => {
    // "Firstmate" matches on its "Coordinator" role tag, not its name.
    expect(filterContactRows(rows, "o").map((row) => row.name)).toEqual([
      "Firstmate",
      "Code Monkey",
      "Scout",
    ]);
  });

  it("answers nothing when nothing matches", () => {
    expect(filterContactRows(rows, "zzz")).toEqual([]);
  });
});

describe("getContactGroupSections", () => {
  it("has no sections at all for an empty rail", () => {
    expect(getContactGroupSections([])).toEqual([]);
  });

  it("buckets everything into the implicit Ungrouped section when nothing is filed", () => {
    const rows = getContactRowViews({
      entries: [entry(), entry({ bot: bot({ id: "bot_2" as BotId, name: "Coder" }) })],
      projects: [],
      templates: [],
    } as unknown as AdeRoster);
    const sections = getContactGroupSections(rows);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.groupId).toBe(UNGROUPED_SECTION_ID);
    expect(sections[0]!.rows.map((row) => row.name)).toEqual(["Firstmate", "Coder"]);
  });

  it("renders captain groups in their order with Ungrouped always trailing", () => {
    const rows = getContactRowViews({
      entries: [
        entry({ bot: bot({ id: "bot_1" as BotId, name: "Firstmate" }) }),
        entry({ bot: bot({ id: "bot_2" as BotId, name: "Coder", groupId: BACKEND }) }),
        entry({ bot: bot({ id: "bot_3" as BotId, name: "Designer", groupId: FRONTEND }) }),
        entry({ bot: bot({ id: "bot_4" as BotId, name: "Reviewer", groupId: BACKEND }) }),
      ],
      projects: [],
      templates: [],
    } as unknown as AdeRoster);

    const sections = getContactGroupSections(rows, [
      group(BACKEND, "Backend", 0),
      group(FRONTEND, "Frontend", 1),
    ]);

    expect(sections.map((section) => section.name)).toEqual([
      "Backend",
      "Frontend",
      UNGROUPED_SECTION_NAME,
    ]);
    // Server order is preserved inside a bucket; nothing here re-sorts.
    expect(sections[0]!.rows.map((row) => row.name)).toEqual(["Coder", "Reviewer"]);
    expect(sections[2]!.rows.map((row) => row.name)).toEqual(["Firstmate"]);
  });

  it("drops a group with no rows rather than heading an empty list", () => {
    const rows = getContactRowViews({
      entries: [entry({ bot: bot({ id: "bot_2" as BotId, name: "Coder", groupId: BACKEND }) })],
      projects: [],
      templates: [],
    } as unknown as AdeRoster);

    const sections = getContactGroupSections(rows, [
      group(BACKEND, "Backend", 0),
      group(FRONTEND, "Frontend", 1),
    ]);

    expect(sections.map((section) => section.name)).toEqual(["Backend"]);
  });

  /**
   * The rail is where a captain would notice a bot went missing, so it must
   * never be the thing that hides one.
   */
  it("falls a bot in an unknown group back to Ungrouped instead of hiding it", () => {
    const rows = getContactRowViews({
      entries: [entry({ bot: bot({ id: "bot_2" as BotId, name: "Coder", groupId: BACKEND }) })],
      projects: [],
      templates: [],
    } as unknown as AdeRoster);

    const sections = getContactGroupSections(rows, []);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.groupId).toBe(UNGROUPED_SECTION_ID);
    expect(sections[0]!.rows.map((row) => row.name)).toEqual(["Coder"]);
  });
});

describe("contactRailEmptyCopy", () => {
  it("distinguishes an empty fleet from a search that matched nothing", () => {
    expect(contactRailEmptyCopy({ totalRows: 0, query: "" }).title).toBe("No bots yet");
    const filtered = contactRailEmptyCopy({ totalRows: 9, query: " zzz " });
    expect(filtered.title).toBe("No matches");
    expect(filtered.description).toContain("zzz");
  });

  /**
   * An empty Attention view is the *good* outcome — it is what the retired
   * needs-you inbox reported when the captain was caught up. Telling a captain
   * with nine bots that they have no bots would be the rail's worst sentence.
   */
  it("reports a caught-up Attention view as good news, not as an empty fleet", () => {
    const copy = contactRailEmptyCopy({ totalRows: 9, query: "", filter: "attention" });
    expect(copy.title).toBe("Nothing needs you");
    expect(copy.description).not.toContain("No bots");
  });

  it("still reports a failed search inside the Attention view as a failed search", () => {
    expect(contactRailEmptyCopy({ totalRows: 9, query: "zzz", filter: "attention" }).title).toBe(
      "No matches",
    );
  });
});

// ---------------------------------------------------------------------------
// Roster liveness (M3): previews, unread, attention.
// ---------------------------------------------------------------------------

const message = (
  overrides: Partial<NonNullable<AdeRosterEntry["lastMessage"]>> = {},
): AdeRosterEntry["lastMessage"] =>
  ({
    preview: "All green.",
    at: "2026-08-24T10:00:00.000Z",
    author: "bot",
    ...overrides,
  }) as NonNullable<AdeRosterEntry["lastMessage"]>;

describe("resolveSecondaryLine", () => {
  it("quotes the bot verbatim", () => {
    const resolved = resolveSecondaryLine({ lastMessage: message(), fallback: "shuv2code" });
    expect(resolved.line).toBe("All green.");
    expect(resolved.kind).toBe("preview");
  });

  /**
   * The captain is prefixed, never named. Printing their own name back at them
   * spends the row's scarcest resource — horizontal space at 380px — on the one
   * participant whose identity is never in question.
   */
  it("prefixes the captain's own last word rather than naming them", () => {
    expect(
      resolveSecondaryLine({
        lastMessage: message({ author: "captain", preview: "ship it" }),
        fallback: "shuv2code",
      }).line,
    ).toBe("You: ship it");
  });

  it("leaves a system line unattributed", () => {
    expect(
      resolveSecondaryLine({
        lastMessage: message({ author: "system", preview: "Session ended." }),
        fallback: "shuv2code",
      }).line,
    ).toBe("Session ended.");
  });

  /**
   * The last term of preview precedence (§4): with nothing to quote the row
   * describes the bot. A blank second line under a name reads as a rendering
   * bug rather than as silence.
   */
  it("falls back to describing the bot when there is nothing to quote", () => {
    const resolved = resolveSecondaryLine({ lastMessage: null, fallback: "shuv2code · 2 open" });
    expect(resolved.line).toBe("shuv2code · 2 open");
    expect(resolved.kind).toBe("description");
  });

  it("treats an empty preview as nothing to quote", () => {
    expect(
      resolveSecondaryLine({ lastMessage: message({ preview: "" }), fallback: "shuv2code" }).kind,
    ).toBe("description");
  });
});

describe("getContactRowView liveness", () => {
  it("carries the tail, its relative time, and the unread count onto the row", () => {
    const view = getContactRowView(
      entry({
        projectName: "shuv2code",
        lastMessage: message({ preview: "Opened PR #12." }),
        unreadCount: 3,
      }),
    );
    expect(view.secondaryLine).toBe("Opened PR #12.");
    expect(view.secondaryKind).toBe("preview");
    expect(view.timeIso).toBe("2026-08-24T10:00:00.000Z");
    expect(view.timeLabel).not.toBeNull();
    expect(view.unreadCount).toBe(3);
    expect(view.unreadLabel).toBe("3 unread messages");
  });

  it("has no time and no unread affordance for a conversation that never started", () => {
    const view = getContactRowView(entry({ projectName: "shuv2code" }));
    expect(view.timeLabel).toBeNull();
    expect(view.timeIso).toBeNull();
    expect(view.unreadCount).toBe(0);
    expect(view.unreadLabel).toBeNull();
    // M1's description survives as the fallback rather than being replaced.
    expect(view.secondaryLine).toBe("shuv2code");
  });

  it("carries the server's amber line without rewriting it", () => {
    // The line is composed server-side so web and mobile cannot drift into two
    // vocabularies; the row's job is to render it, not to re-derive it.
    const view = getContactRowView(
      entry({
        attention: { kind: "approval", line: "Approval required: a change is waiting" },
      } as Partial<AdeRosterEntry>),
    );
    expect(view.attentionLine).toBe("Approval required: a change is waiting");
  });

  it("has no attention line when nothing is waiting", () => {
    expect(getContactRowView(entry()).attentionLine).toBeNull();
  });

  /**
   * The contract defaults all three liveness fields on decode, so a payload
   * from a server that predates M3 arrives complete. A roster that never went
   * through a decoder does not, and the rail must render it rather than throw:
   * a missing field is the same fact as an empty one, and a contact list is the
   * wrong place to discover a schema-version mismatch.
   */
  it("renders a pre-M3 entry that never carried the liveness fields at all", () => {
    const legacy = {
      bot: bot(),
      projectName: "shuv2code",
      hasActivePrimarySession: false,
      openAssignmentCount: 0,
    } as unknown as AdeRosterEntry;

    const view = getContactRowView(legacy);
    expect(view.secondaryLine).toBe("shuv2code");
    expect(view.secondaryKind).toBe("description");
    expect(view.attentionLine).toBeNull();
    expect(view.timeLabel).toBeNull();
    expect(view.unreadCount).toBe(0);
  });
});

describe("unreadBadgeLabel", () => {
  it("prints the count until it stops being information", () => {
    expect(unreadBadgeLabel(1)).toBe("1");
    expect(unreadBadgeLabel(42)).toBe("42");
    expect(unreadBadgeLabel(UNREAD_DISPLAY_CAP)).toBe(`${UNREAD_DISPLAY_CAP}+`);
  });
});

describe("unreadAnnouncement", () => {
  it("says nothing when there is nothing unread", () => {
    expect(unreadAnnouncement(0)).toBeNull();
    expect(unreadAnnouncement(-1)).toBeNull();
  });

  it("gives the dot words, since a coloured circle announces nothing", () => {
    expect(unreadAnnouncement(1)).toBe("1 unread message");
    expect(unreadAnnouncement(4)).toBe("4 unread messages");
    expect(unreadAnnouncement(500)).toBe(`${UNREAD_DISPLAY_CAP}+ unread messages`);
  });
});

describe("parseContactRailFilter", () => {
  it("recognises the one narrowed view", () => {
    expect(parseContactRailFilter("attention")).toBe("attention");
  });

  /**
   * A deep link with a stale or mistyped query string should show the captain
   * their fleet, not an error about a URL. `/fleet/needs-you` redirects into
   * this parameter, so it has to survive anything a bookmark carries.
   */
  it("falls anything else back to the whole fleet", () => {
    for (const raw of ["all", "", "ATTENTION", "needs-you", undefined, null, 3, {}]) {
      expect(parseContactRailFilter(raw)).toBe("all");
    }
  });
});

describe("applyContactRailFilter", () => {
  const rows = getContactRowViews({
    entries: [
      entry({ bot: bot({ id: "bot_1" as BotId, name: "Firstmate" }) }),
      entry({
        bot: bot({ id: "bot_2" as BotId, name: "Coder" }),
        attention: { kind: "approval", line: "Approval required: a change is waiting" },
        unreadCount: 1,
      } as Partial<AdeRosterEntry>),
      entry({
        bot: bot({ id: "bot_3" as BotId, name: "Scout" }),
        unreadCount: 9,
      } as Partial<AdeRosterEntry>),
    ],
    projects: [],
    templates: [],
  } as unknown as AdeRoster);

  it("changes nothing in the default view", () => {
    expect(applyContactRailFilter(rows, "all")).toEqual(rows);
  });

  /**
   * Unread is "you have not looked"; attention is "something is waiting on a
   * decision". Folding the two would bury one approval under nine chatty bots,
   * which is the exact failure the needs-you inbox existed to prevent — and the
   * job this filter is inheriting.
   */
  it("keeps only what is waiting on a decision, never merely what is unread", () => {
    const filtered = applyContactRailFilter(rows, "attention");
    expect(filtered.map((row) => row.name)).toEqual(["Coder"]);
  });

  it("preserves the server's order among what it keeps", () => {
    expect(applyContactRailFilter(rows, "attention").map((row) => row.botId)).toEqual(["bot_2"]);
  });
});

describe("filterContactRows over previews", () => {
  const rows = getContactRowViews({
    entries: [
      entry({
        bot: bot({ id: "bot_1" as BotId, name: "Firstmate" }),
        projectName: "shuv2code",
      }),
      entry({
        bot: bot({ id: "bot_2" as BotId, name: "Coder", roleTag: "Coder" }),
        projectName: "shuv2code",
        lastMessage: message({ preview: "Deploy is green." }),
      } as Partial<AdeRosterEntry>),
    ],
    projects: [],
    templates: [],
  } as unknown as AdeRoster);

  it("finds a bot by what it last said (§2)", () => {
    expect(filterContactRows(rows, "deploy").map((row) => row.name)).toEqual(["Coder"]);
  });

  /**
   * Only a quoted line is searchable. The description fallback restates the
   * project name, and matching that would make searching "shuv2code" return the
   * entire fleet — a filter that selects everything is not a filter.
   */
  it("does not match the description fallback", () => {
    expect(filterContactRows(rows, "shuv2code")).toEqual([]);
  });
});
