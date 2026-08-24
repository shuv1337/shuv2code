import { describe, expect, it } from "vite-plus/test";

import type { FleetHealthSnapshot } from "@shuv2code/contracts";

import { getKernelHealthPillViews } from "./SidebarKernelHealthPills.logic";

const snapshot: FleetHealthSnapshot = {
  targets: [
    {
      target: "shuvcode",
      state: "healthy",
      detail: "attached to http://127.0.0.1:4096",
      since: "2026-08-24T00:00:00.000Z",
      checkedAt: "2026-08-24T00:05:00.000Z",
    },
    {
      target: "codex",
      state: "down",
      detail: "codex app-server exited (2 consecutive failures)",
      since: "2026-08-24T00:04:00.000Z",
      checkedAt: "2026-08-24T00:05:00.000Z",
    },
    {
      target: "screenbox",
      state: "not-provisioned",
      detail: null,
      since: "2026-08-24T00:00:00.000Z",
      checkedAt: "2026-08-24T00:05:00.000Z",
    },
  ],
};

describe("getKernelHealthPillViews", () => {
  it("maps every target to its pill in fixed order", () => {
    const pills = getKernelHealthPillViews(snapshot);
    expect(pills.map((pill) => pill.target)).toEqual(["shuvcode", "codex", "screenbox"]);
    expect(pills.map((pill) => pill.state)).toEqual(["healthy", "down", "not-provisioned"]);
  });

  it("colors healthy green, down red with ping, dormant muted without ping", () => {
    const [shuvcode, codex, screenbox] = getKernelHealthPillViews(snapshot);
    expect(shuvcode!.dotClassName).toBe("bg-success");
    expect(shuvcode!.pingClassName).toBeNull();
    expect(codex!.dotClassName).toBe("bg-destructive");
    expect(codex!.pingClassName).toContain("bg-destructive");
    expect(screenbox!.dotClassName).toContain("bg-muted-foreground");
    expect(screenbox!.pingClassName).toBeNull();
  });

  it("appends probe detail to the tooltip when present", () => {
    const [shuvcode, codex, screenbox] = getKernelHealthPillViews(snapshot);
    expect(codex!.tooltip).toBe(
      "Codex kernel: down\ncodex app-server exited (2 consecutive failures)",
    );
    expect(shuvcode!.tooltip).toContain("shuvcode kernel: healthy");
    expect(screenbox!.tooltip).toBe("Screenbox runtime: not provisioned");
  });

  it("renders every target as unknown before the first snapshot", () => {
    const pills = getKernelHealthPillViews(null);
    expect(pills).toHaveLength(3);
    for (const pill of pills) {
      expect(pill.state).toBe("unknown");
      expect(pill.tooltip).toContain("checking…");
      expect(pill.pingClassName).toBeNull();
    }
  });

  it("treats a target missing from the snapshot as unknown", () => {
    const pills = getKernelHealthPillViews({ targets: [snapshot.targets[0]!] });
    expect(pills[0]!.state).toBe("healthy");
    expect(pills[1]!.state).toBe("unknown");
    expect(pills[2]!.state).toBe("unknown");
  });
});
