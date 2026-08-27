import type { FleetHealthSnapshot } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getKernelHealthAlertViews,
  getKernelHealthPillViews,
  kernelHealthAlertLine,
} from "./kernelHealth.logic";

const snapshot = (
  states: ReadonlyArray<
    readonly [FleetHealthSnapshot["targets"][number]["target"], "healthy" | "down" | "unknown"]
  >,
): FleetHealthSnapshot => ({
  targets: states.map(([target, state]) => ({
    target,
    state,
    detail: state === "down" ? `${target} exited` : null,
    since: "2026-08-24T00:00:00.000Z",
    checkedAt: "2026-08-24T00:05:00.000Z",
  })),
});

describe("getKernelHealthPillViews", () => {
  it("gives every state a literal class so Uniwind can emit it", () => {
    const pills = getKernelHealthPillViews(
      snapshot([
        ["shuvcode", "healthy"],
        ["codex", "down"],
      ]),
    );
    expect(pills.map((pill) => pill.dotClassName)).toEqual([
      "bg-emerald-500",
      "bg-red-500",
      // screenbox is absent from the snapshot, so it reads as unknown.
      "bg-foreground-tertiary",
    ]);
  });

  it("puts the probe's own words into the accessibility label", () => {
    const codex = getKernelHealthPillViews(snapshot([["codex", "down"]]))[1];
    expect(codex?.accessibilityLabel).toBe("Codex kernel: down. codex exited");
  });

  it("says only the summary when the probe had nothing to add", () => {
    const shuvcode = getKernelHealthPillViews(snapshot([["shuvcode", "healthy"]]))[0];
    expect(shuvcode?.accessibilityLabel).toBe("shuvcode kernel: healthy");
  });
});

describe("getKernelHealthAlertViews", () => {
  it("stays silent while nothing is down", () => {
    expect(
      getKernelHealthAlertViews(
        snapshot([
          ["shuvcode", "healthy"],
          ["codex", "healthy"],
        ]),
      ),
    ).toEqual([]);
  });

  it("stays silent before the first probe comes back", () => {
    expect(getKernelHealthAlertViews(null)).toEqual([]);
  });

  it("surfaces exactly the targets that are down", () => {
    const alerts = getKernelHealthAlertViews(
      snapshot([
        ["shuvcode", "down"],
        ["codex", "healthy"],
      ]),
    );
    expect(alerts.map((alert) => alert.target)).toEqual(["shuvcode"]);
  });
});

describe("kernelHealthAlertLine", () => {
  it("returns nothing to say when nothing is down", () => {
    expect(kernelHealthAlertLine([])).toBeNull();
  });

  it("names the one target rather than counting it", () => {
    const line = kernelHealthAlertLine(getKernelHealthAlertViews(snapshot([["codex", "down"]])));
    expect(line).toBe("Codex kernel is down");
  });

  it("names every target when several are out", () => {
    const line = kernelHealthAlertLine(
      getKernelHealthAlertViews(
        snapshot([
          ["shuvcode", "down"],
          ["codex", "down"],
        ]),
      ),
    );
    expect(line).toBe("shuvcode kernel and Codex kernel are down");
  });
});
