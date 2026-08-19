export const VOICE_PRESENCE_IDENTITY_MORPH_DURATION_MS = 700;

/**
 * A bounded wall-clock transition. Dropped frames advance to the point the
 * user should currently see instead of replaying missed animation afterward.
 */
export function voicePresenceIdentityMorphProgress(elapsedMs: number): number {
  const finiteElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const linear = Math.min(
    1,
    Math.max(0, finiteElapsed / VOICE_PRESENCE_IDENTITY_MORPH_DURATION_MS),
  );
  return 1 - (1 - linear) ** 4;
}
