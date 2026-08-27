import type { FleetHealthSnapshot } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getKernelHealthTargetViews, kernelHealthOutages } from "./kernelHealth.ts";

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

describe("getKernelHealthTargetViews", () => {
  it("returns every target in fixed order with its own state", () => {
    const views = getKernelHealthTargetViews(snapshot);
    expect(views.map((view) => view.target)).toEqual(["shuvcode", "codex", "screenbox"]);
    expect(views.map((view) => view.state)).toEqual(["healthy", "down", "not-provisioned"]);
    expect(views.map((view) => view.label)).toEqual(["shuvcode", "Codex", "Screen"]);
  });

  it("summarises a target as its full name and state", () => {
    const codex = getKernelHealthTargetViews(snapshot)[1];
    expect(codex?.summary).toBe("Codex kernel: down");
    expect(codex?.detail).toBe("codex app-server exited (2 consecutive failures)");
  });

  it("reads a missing snapshot as unknown rather than as nothing", () => {
    const views = getKernelHealthTargetViews(null);
    expect(views).toHaveLength(3);
    expect(views.every((view) => view.state === "unknown")).toBe(true);
    expect(views[0]?.stateText).toBe("checking…");
    expect(views.every((view) => view.detail === null)).toBe(true);
  });

  it("reads an empty probe detail as no detail at all", () => {
    const views = getKernelHealthTargetViews({
      targets: [
        {
          target: "shuvcode",
          state: "healthy",
          detail: "",
          since: "2026-08-24T00:00:00.000Z",
          checkedAt: "2026-08-24T00:05:00.000Z",
        },
      ],
    });
    expect(views[0]?.detail).toBeNull();
  });
});

describe("kernelHealthOutages", () => {
  it("keeps only the targets that are actually down", () => {
    const outages = kernelHealthOutages(getKernelHealthTargetViews(snapshot));
    expect(outages.map((view) => view.target)).toEqual(["codex"]);
  });

  it("treats a dormant or unprobed target as no news", () => {
    expect(kernelHealthOutages(getKernelHealthTargetViews(null))).toEqual([]);
  });
});
