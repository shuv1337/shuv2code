import type {
  AdeBotDetail,
  BotExecutionBinding,
  PersonaVersion,
  PersonaVersionId,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSaveMemory,
  getBindingRowViews,
  getBotHeaderView,
  getPersonaVersionViews,
  PERSONA_EDIT_NOTE,
} from "./botDetail.ts";

function binding(overrides: Record<string, unknown>): BotExecutionBinding {
  return {
    id: "bnd_1",
    botId: "bot_1",
    engine: "shuvcode",
    sessionId: "ses_1",
    purpose: "primary-text",
    status: "historical",
    rolloverSummary: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  } as BotExecutionBinding;
}

describe("getBotHeaderView", () => {
  it("names a fleet-wide bot's home and its structural role", () => {
    const detail = {
      bot: {
        name: "Firstmate",
        structuralRole: "firstmate",
        roleTag: "Coordinator",
        computerUse: true,
      },
      projectName: null,
    } as unknown as AdeBotDetail;
    expect(getBotHeaderView(detail)).toEqual({
      name: "Firstmate",
      roleLabel: "Firstmate",
      roleTag: "Coordinator",
      projectLabel: "Fleet-wide",
      computerUse: true,
      isFirstmate: true,
    });
  });

  it("uses the project name when the bot has one", () => {
    const detail = {
      bot: {
        name: "Coder",
        structuralRole: "crew",
        roleTag: "Coder",
        computerUse: false,
      },
      projectName: "shuv2code",
    } as unknown as AdeBotDetail;
    const view = getBotHeaderView(detail);
    expect(view.projectLabel).toBe("shuv2code");
    expect(view.roleLabel).toBe("Crew");
    expect(view.isFirstmate).toBe(false);
  });
});

describe("getBindingRowViews", () => {
  it("puts active sessions first and the rest newest-first", () => {
    const rows = getBindingRowViews([
      binding({ id: "bnd_old", updatedAt: "2026-08-20T00:00:00.000Z" }),
      binding({ id: "bnd_new", updatedAt: "2026-08-23T00:00:00.000Z" }),
      binding({ id: "bnd_live", status: "active", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["bnd_live", "bnd_new", "bnd_old"]);
  });

  it("labels purposes and statuses for the table", () => {
    const [row] = getBindingRowViews([
      binding({ status: "lost", purpose: "voice", engine: "codex" }),
    ]);
    expect(row?.purpose).toBe("Voice");
    expect(row?.statusVariant).toBe("error");
    expect(row?.engine).toBe("codex");
  });
});

describe("getPersonaVersionViews", () => {
  const versions = [
    {
      id: "pv_3" as PersonaVersionId,
      botId: "bot_1",
      content: "newest",
      createdAt: "2026-08-24T00:00:00.000Z",
      activatedAt: null,
    },
    {
      id: "pv_2" as PersonaVersionId,
      botId: "bot_1",
      content: "current",
      createdAt: "2026-08-23T00:00:00.000Z",
      activatedAt: "2026-08-23T00:01:00.000Z",
    },
    {
      id: "pv_1" as PersonaVersionId,
      botId: "bot_1",
      content: "old",
      createdAt: "2026-08-22T00:00:00.000Z",
      activatedAt: "2026-08-22T00:01:00.000Z",
    },
  ] as unknown as ReadonlyArray<PersonaVersion>;

  it("marks the head pending, the active one active, and the rest superseded", () => {
    expect(
      getPersonaVersionViews(versions, "pv_2" as PersonaVersionId).map((view) => view.stateLabel),
    ).toEqual(["Pending", "Active", "Superseded"]);
  });

  it("preserves the server's newest-first order", () => {
    expect(getPersonaVersionViews(versions, null).map((view) => view.id)).toEqual([
      "pv_3",
      "pv_2",
      "pv_1",
    ]);
  });
});

describe("canSaveMemory", () => {
  it("refuses to write text identical to what the server holds", () => {
    expect(canSaveMemory({ draft: "a", saved: "a", busy: false })).toBe(false);
  });

  it("refuses before the document has loaded, and while a save is in flight", () => {
    expect(canSaveMemory({ draft: "a", saved: null, busy: false })).toBe(false);
    expect(canSaveMemory({ draft: "b", saved: "a", busy: true })).toBe(false);
  });

  it("allows a real edit", () => {
    expect(canSaveMemory({ draft: "b", saved: "a", busy: false })).toBe(true);
  });
});

describe("PERSONA_EDIT_NOTE", () => {
  it("says when the edit lands, because it is not now", () => {
    expect(PERSONA_EDIT_NOTE).toContain("next session");
  });
});
