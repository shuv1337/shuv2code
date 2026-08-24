import type { FleetHealthSnapshot } from "@shuv2code/contracts";
import type { SupervisorConnectionState } from "@shuv2code/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { fleetHealthForConnectionPhase } from "./ade.logic";

const snapshot: FleetHealthSnapshot = {
  targets: [
    {
      target: "shuvcode",
      state: "healthy",
      detail: null,
      since: "2026-08-24T00:00:00.000Z",
      checkedAt: "2026-08-24T00:05:00.000Z",
    },
  ],
};

describe("fleetHealthForConnectionPhase", () => {
  it("passes the snapshot through while connected", () => {
    expect(fleetHealthForConnectionPhase("connected", snapshot)).toBe(snapshot);
    expect(fleetHealthForConnectionPhase("connected", null)).toBeNull();
  });

  it.each([
    "connecting",
    "available",
    "offline",
    "backoff",
    "blocked",
  ] as const satisfies ReadonlyArray<SupervisorConnectionState["phase"]>)(
    "discards a stale snapshot while %s so pills fall back to unknown",
    (phase) => {
      expect(fleetHealthForConnectionPhase(phase, snapshot)).toBeNull();
    },
  );
});
