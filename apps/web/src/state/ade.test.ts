import type { AdeBotDetail, BotExecutionBinding, FleetHealthSnapshot } from "@shuv2code/contracts";
import type { SupervisorConnectionState } from "@shuv2code/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  activePrimaryBinding,
  adeCaptainErrorMessage,
  adeCaptainErrorReason,
  fleetHealthForConnectionPhase,
  openAssignments,
  runningAssignment,
  structuralRoleLabel,
} from "./ade.logic";

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

const bindings = [
  { id: "bnd_1", purpose: "voice", status: "active" },
  { id: "bnd_2", purpose: "primary-text", status: "historical" },
  { id: "bnd_3", purpose: "primary-text", status: "active" },
] as unknown as ReadonlyArray<BotExecutionBinding>;

describe("adeCaptainErrorReason", () => {
  it("narrows a tagged captain error to its reason", () => {
    expect(adeCaptainErrorReason({ _tag: "AdeCaptainError", reason: "memory_conflict" })).toBe(
      "memory_conflict",
    );
  });

  it("reads anything else as not a captain error", () => {
    expect(adeCaptainErrorReason(new Error("socket closed"))).toBeNull();
    expect(adeCaptainErrorReason({ _tag: "EnvironmentAuthorizationError" })).toBeNull();
    expect(adeCaptainErrorReason(null)).toBeNull();
    expect(adeCaptainErrorReason("memory_conflict")).toBeNull();
  });
});

describe("adeCaptainErrorMessage", () => {
  it("explains the reason and appends the server's own words", () => {
    expect(
      adeCaptainErrorMessage(
        { _tag: "AdeCaptainError", reason: "session_unavailable", message: "Codex is down." },
        "fallback",
      ),
    ).toBe("No kernel session is available right now. Codex is down.");
  });

  it("uses the reason alone when the server said nothing more", () => {
    expect(
      adeCaptainErrorMessage({ _tag: "AdeCaptainError", reason: "memory_conflict" }, "fallback"),
    ).toBe("Memory changed elsewhere — reload before saving.");
  });

  it("falls back for transport faults", () => {
    expect(adeCaptainErrorMessage(new Error("socket closed"), "fallback")).toBe("socket closed");
    expect(adeCaptainErrorMessage({}, "fallback")).toBe("fallback");
  });
});

describe("structuralRoleLabel", () => {
  it("prints every structural role in the captain's vocabulary", () => {
    expect(structuralRoleLabel("firstmate")).toBe("Firstmate");
    expect(structuralRoleLabel("second-mate")).toBe("Second Mate");
    expect(structuralRoleLabel("crew")).toBe("Crew");
    expect(structuralRoleLabel("workspace-specialist")).toBe("Workspace specialist");
  });
});

describe("activePrimaryBinding", () => {
  it("finds the live chat session and ignores other purposes and dead ones", () => {
    expect(activePrimaryBinding(bindings)?.id).toBe("bnd_3");
    expect(activePrimaryBinding(bindings.slice(0, 2))).toBeNull();
    expect(activePrimaryBinding([])).toBeNull();
  });
});

describe("openAssignments / runningAssignment", () => {
  const detail = {
    assignments: [
      { id: "asg_1", status: "queued", instruction: "later" },
      { id: "asg_2", status: "running", instruction: "now" },
      { id: "asg_3", status: "blocked", instruction: "stuck" },
      { id: "asg_4", status: "completed", instruction: "done" },
      { id: "asg_5", status: "cancelled", instruction: "dropped" },
    ],
  } as unknown as AdeBotDetail;

  it("keeps queued, running and blocked work in queue order", () => {
    expect(openAssignments(detail).map((assignment) => assignment.id)).toEqual([
      "asg_1",
      "asg_2",
      "asg_3",
    ]);
  });

  it("names only the assignment actually executing", () => {
    expect(runningAssignment(detail)?.id).toBe("asg_2");
    expect(runningAssignment({ assignments: [] } as unknown as AdeBotDetail)).toBeNull();
  });
});
