import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { FleetHealthSnapshot } from "@shuv2code/contracts";

const atoms = vi.hoisted(() => ({
  fleetHealth: null as FleetHealthSnapshot | null,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.fleetHealth,
}));

vi.mock("../../state/ade", () => ({
  primaryFleetHealthAtom: Symbol("primaryFleetHealthAtom"),
}));

const { SidebarKernelHealthPills } = await import("./SidebarKernelHealthPills");

describe("SidebarKernelHealthPills", () => {
  it("renders three unknown pills before any snapshot arrives", () => {
    atoms.fleetHealth = null;
    const markup = renderToStaticMarkup(<SidebarKernelHealthPills />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Kernel health"');
    expect(markup).toContain("shuvcode");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Screen");
    expect(markup).not.toContain("bg-success");
    expect(markup).not.toContain("bg-destructive");
  });

  it("renders healthy, down, and dormant states from a snapshot", () => {
    atoms.fleetHealth = {
      targets: [
        {
          target: "shuvcode",
          state: "healthy",
          detail: null,
          since: "2026-08-24T00:00:00.000Z",
          checkedAt: "2026-08-24T00:05:00.000Z",
        },
        {
          target: "codex",
          state: "down",
          detail: "codex app-server exited (1 consecutive failure)",
          since: "2026-08-24T00:04:00.000Z",
          checkedAt: "2026-08-24T00:05:00.000Z",
        },
        {
          target: "screenbox",
          state: "not-provisioned",
          detail: "Screenbox runtime is not provisioned.",
          since: "2026-08-24T00:00:00.000Z",
          checkedAt: "2026-08-24T00:05:00.000Z",
        },
      ],
    };
    const markup = renderToStaticMarkup(<SidebarKernelHealthPills />);

    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-destructive");
    expect(markup).toContain("animate-status-ping");
    expect(markup).toContain("bg-muted-foreground/40");
    // Tooltip/title carries the outage detail for the captain.
    expect(markup).toContain("codex app-server exited (1 consecutive failure)");
  });
});
