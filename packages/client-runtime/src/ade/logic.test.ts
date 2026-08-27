import type { AdeBotDetail, BotExecutionBinding, FleetHealthSnapshot } from "@shuv2code/contracts";
import type { SupervisorConnectionState } from "../connection/index.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  activePrimaryBinding,
  adeCaptainErrorMessage,
  adeCaptainErrorParts,
  adeCaptainErrorReason,
  fleetHealthForConnectionPhase,
  openAssignments,
  runningAssignment,
  structuralRoleLabel,
} from "./logic.ts";

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
    ).toBe("This bot isn't connected. Codex is down.");
  });

  it("splits rather than concatenates for surfaces with a disclosure", () => {
    // #217: the concatenated form is what produced a paragraph of provider
    // setup as primary UI copy.
    const parts = adeCaptainErrorParts(
      {
        _tag: "AdeCaptainError",
        reason: "session_unavailable",
        message: "No 'opencode2' provider instance is configured.",
      },
      "fallback",
    );
    expect(parts.headline).toBe("This bot isn't connected.");
    expect(parts.headline).not.toContain("opencode2");
    expect(parts.details).toBe("No 'opencode2' provider instance is configured.");
  });

  it("has no detail to disclose when the server said nothing more", () => {
    expect(
      adeCaptainErrorParts({ _tag: "AdeCaptainError", reason: "memory_conflict" }, "fallback")
        .details,
    ).toBeNull();
  });

  it("keeps an untagged Error's text as the detail, not the headline", () => {
    const parts = adeCaptainErrorParts(
      new Error("ECONNREFUSED 127.0.0.1:4096"),
      "Couldn't connect.",
    );
    expect(parts.headline).toBe("Couldn't connect.");
    expect(parts.details).toBe("ECONNREFUSED 127.0.0.1:4096");
  });

  it("stays cause-neutral on the session_unavailable bucket", () => {
    /*
     * #217: `session_unavailable` covers a missing project, an unbound repo, a
     * failed workspace create, a down kernel and a model-less provider
     * instance. The headline may therefore name neither the subsystem that
     * refused nor any one remedy — it would be wrong for most causes, and it
     * can render directly above a no-project CTA that contradicts it.
     */
    const headline = adeCaptainErrorMessage(
      { _tag: "AdeCaptainError", reason: "session_unavailable" },
      "fallback",
    );
    expect(headline).toBe("This bot isn't connected.");
    for (const cause of ["kernel", "provider", "project", "repository", "model"]) {
      expect(headline).not.toContain(cause);
    }
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
