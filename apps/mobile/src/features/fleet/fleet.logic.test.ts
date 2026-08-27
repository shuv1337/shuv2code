import type { AdeBotGroupId, BotId, EnvironmentId } from "@shuv2code/contracts";
import type { ContactRowView } from "@shuv2code/client-runtime/ade/contact-rail";
import { BOT_AVATAR_COLORS } from "@shuv2code/client-runtime/ade/bot-identity";
import { describe, expect, it } from "vite-plus/test";

import {
  botAvatarTintClassNames,
  buildFleetListItems,
  isBotChatReadable,
  resolveAdeEnvironmentId,
  resolveBotAvatarTint,
} from "./fleet.logic";

const environmentId = (value: string) => value as EnvironmentId;

function row(botId: string, groupId: string | null): ContactRowView {
  return {
    botId: botId as BotId,
    name: botId,
    roleLabel: "Crew",
    roleTag: "coder",
    projectLabel: "Fleet-wide",
    isFirstmate: false,
    openAssignmentLabel: null,
    chatLabel: "Chat",
    isOnline: false,
    presenceLabel: "No session",
    secondaryLine: "Fleet-wide",
    secondaryKind: "description",
    attentionLine: null,
    timeLabel: null,
    timeIso: null,
    unreadCount: 0,
    unreadLabel: null,
    avatar: { emoji: null, color: null, initials: "B", hue: 12 },
    groupId: groupId === null ? null : (groupId as AdeBotGroupId),
  };
}

describe("resolveAdeEnvironmentId", () => {
  it("prefers the captain's explicit choice", () => {
    expect(
      resolveAdeEnvironmentId({
        environments: [
          { environmentId: environmentId("a"), connectionState: "connected" },
          { environmentId: environmentId("b"), connectionState: "offline" },
        ],
        preferredEnvironmentId: environmentId("b"),
      }),
    ).toBe("b");
  });

  it("ignores a choice that is no longer a known environment", () => {
    expect(
      resolveAdeEnvironmentId({
        environments: [{ environmentId: environmentId("a"), connectionState: "connected" }],
        preferredEnvironmentId: environmentId("gone"),
      }),
    ).toBe("a");
  });

  it("falls back to the connected environment before the first one", () => {
    expect(
      resolveAdeEnvironmentId({
        environments: [
          { environmentId: environmentId("a"), connectionState: "offline" },
          { environmentId: environmentId("b"), connectionState: "connected" },
        ],
        preferredEnvironmentId: null,
      }),
    ).toBe("b");
  });

  it("falls back to the first environment when nothing is connected", () => {
    expect(
      resolveAdeEnvironmentId({
        environments: [
          { environmentId: environmentId("a"), connectionState: "connecting" },
          { environmentId: environmentId("b"), connectionState: "offline" },
        ],
        preferredEnvironmentId: null,
      }),
    ).toBe("a");
  });

  it("answers null with no environments at all", () => {
    expect(resolveAdeEnvironmentId({ environments: [], preferredEnvironmentId: null })).toBeNull();
  });
});

describe("buildFleetListItems", () => {
  it("drops the header when the whole roster is one implicit bucket", () => {
    const items = buildFleetListItems({ rows: [row("a", null), row("b", null)], groups: [] });
    expect(items.map((item) => item.kind)).toEqual(["contact", "contact"]);
  });

  it("keeps headers once there is more than one section", () => {
    const items = buildFleetListItems({
      rows: [row("a", "g1"), row("b", null)],
      groups: [{ id: "g1", name: "Shipping" }],
    });
    expect(items.map((item) => item.kind)).toEqual(["group", "contact", "group", "contact"]);
    expect(items.filter((item) => item.kind === "group").map((item) => item.name)).toEqual([
      "Shipping",
      "Ungrouped",
    ]);
  });

  it("keys every item uniquely, which is what LegendList reconciles on", () => {
    const items = buildFleetListItems({
      rows: [row("a", "g1"), row("b", null)],
      groups: [{ id: "g1", name: "Shipping" }],
    });
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it("returns nothing for an empty roster", () => {
    expect(buildFleetListItems({ rows: [], groups: [] })).toEqual([]);
  });
});

describe("resolveBotAvatarTint", () => {
  it("maps a palette token to a literal Uniwind class", () => {
    expect(resolveBotAvatarTint({ color: "amber", hue: 10 })).toEqual({
      className: "bg-amber-500",
      color: null,
    });
  });

  it("falls back to the deterministic hue for an unknown colour", () => {
    expect(resolveBotAvatarTint({ color: "chartreuse", hue: 200 })).toEqual({
      className: null,
      color: "hsl(200, 62%, 42%)",
    });
  });

  it("falls back to the deterministic hue when nothing is set", () => {
    expect(resolveBotAvatarTint({ color: null, hue: 0 }).color).toBe("hsl(0, 62%, 42%)");
  });

  it("covers every token the contract offers, as literals Uniwind can find", () => {
    const classNames = botAvatarTintClassNames();
    expect(classNames).toHaveLength(BOT_AVATAR_COLORS.length);
    for (const className of classNames) {
      expect(className).toMatch(/^bg-[a-z]+-500$/u);
    }
  });
});

describe("isBotChatReadable", () => {
  const base = { chatReady: true, screenFocused: true, appState: "active" } as const;

  it("is readable only with a live thread, on screen, in the foreground", () => {
    expect(isBotChatReadable(base)).toBe(true);
  });

  it("is not readable while the conversation is still connecting", () => {
    expect(isBotChatReadable({ ...base, chatReady: false })).toBe(false);
  });

  it("is not readable once the screen is pushed under another route", () => {
    expect(isBotChatReadable({ ...base, screenFocused: false })).toBe(false);
  });

  it("is not readable in the background or the app switcher", () => {
    expect(isBotChatReadable({ ...base, appState: "background" })).toBe(false);
    expect(isBotChatReadable({ ...base, appState: "inactive" })).toBe(false);
  });
});
