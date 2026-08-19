// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { describe, expect, it } from "vitest";

import { deriveVoicePresenceIdentity } from "./voicePresenceIdentity";

describe("deriveVoicePresenceIdentity", () => {
  it("derives the same identity for the same durable thread", () => {
    const input = {
      threadId: "thread-123",
      providerKey: "codex-personal",
      projectKey: "project-456",
    };

    expect(deriveVoicePresenceIdentity(input)).toEqual(deriveVoicePresenceIdentity(input));
  });

  it("gives different durable threads distinct palettes and morphology", () => {
    const first = deriveVoicePresenceIdentity({
      threadId: "thread-alpha",
      providerKey: "codex",
      projectKey: "project",
    });
    const second = deriveVoicePresenceIdentity({
      threadId: "thread-beta",
      providerKey: "codex",
      projectKey: "project",
    });

    expect(first.code).not.toBe(second.code);
    expect(first.morphology).not.toEqual(second.morphology);
    expect(first.palette).not.toEqual(second.palette);
  });

  it("lets provider and project flavor color without changing thread-owned structure", () => {
    const first = deriveVoicePresenceIdentity({
      threadId: "thread-123",
      providerKey: "codex",
      projectKey: "project-alpha",
    });
    const second = deriveVoicePresenceIdentity({
      threadId: "thread-123",
      providerKey: "claude",
      projectKey: "project-beta",
    });

    expect(first.code).toBe(second.code);
    expect(first.morphology).toEqual(second.morphology);
    expect(first.palette).not.toEqual(second.palette);
  });

  it("can keep the palette purely thread-owned when contextual tint is disabled", () => {
    const first = deriveVoicePresenceIdentity({
      threadId: "thread-123",
      providerKey: "codex",
      projectKey: "project-alpha",
      contextTint: false,
    });
    const second = deriveVoicePresenceIdentity({
      threadId: "thread-123",
      providerKey: "claude",
      projectKey: "project-beta",
      contextTint: false,
    });

    expect(first.palette).toEqual(second.palette);
  });

  it("reduces morphology variation without changing the thread identity", () => {
    const balanced = deriveVoicePresenceIdentity({
      threadId: "thread-123",
      variation: "balanced",
    });
    const subtle = deriveVoicePresenceIdentity({
      threadId: "thread-123",
      variation: "subtle",
    });

    expect(subtle.code).toBe(balanced.code);
    expect(Math.abs(subtle.morphology.vorticity - 1)).toBeLessThan(
      Math.abs(balanced.morphology.vorticity - 1),
    );
    expect(Math.abs(subtle.morphology.positionX)).toBeLessThan(
      Math.abs(balanced.morphology.positionX),
    );
  });

  it("marks a pre-materialized thread identity as provisional", () => {
    const identity = deriveVoicePresenceIdentity({
      threadId: null,
      providerKey: "codex",
      projectKey: "project-456",
    });

    expect(identity.provisional).toBe(true);
  });

  it("keeps thread morphology within the curated calm range", () => {
    const { morphology } = deriveVoicePresenceIdentity({
      threadId: "thread-range-check",
      providerKey: "codex",
      projectKey: "project",
    });

    expect(morphology.flowSpeed).toBeGreaterThanOrEqual(0.86);
    expect(morphology.flowSpeed).toBeLessThanOrEqual(1.16);
    expect(morphology.vorticity).toBeGreaterThanOrEqual(0.75);
    expect(morphology.vorticity).toBeLessThanOrEqual(1.35);
    expect(Math.abs(morphology.positionX)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(morphology.positionY)).toBeLessThanOrEqual(0.09);
    expect(Math.abs(morphology.tilt)).toBeLessThanOrEqual(0.18);
  });
});
