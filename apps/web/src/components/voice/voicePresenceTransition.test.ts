import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_PRESENCE_IDENTITY_MORPH_DURATION_MS,
  voicePresenceIdentityMorphProgress,
} from "./voicePresenceTransition";

describe("voicePresenceIdentityMorphProgress", () => {
  it("finishes the identity morph within the fixed attention budget", () => {
    expect(voicePresenceIdentityMorphProgress(0)).toBe(0);
    expect(voicePresenceIdentityMorphProgress(VOICE_PRESENCE_IDENTITY_MORPH_DURATION_MS)).toBe(1);
    expect(voicePresenceIdentityMorphProgress(5_000)).toBe(1);
  });

  it("uses a calm ease-out instead of replaying equal frame-sized steps", () => {
    expect(voicePresenceIdentityMorphProgress(175)).toBeCloseTo(0.6836, 3);
    expect(voicePresenceIdentityMorphProgress(350)).toBeCloseTo(0.9375, 4);
    expect(voicePresenceIdentityMorphProgress(525)).toBeCloseTo(0.9961, 3);
  });

  it("clamps invalid and pre-transition elapsed values", () => {
    expect(voicePresenceIdentityMorphProgress(-100)).toBe(0);
    expect(voicePresenceIdentityMorphProgress(Number.NaN)).toBe(0);
  });
});
