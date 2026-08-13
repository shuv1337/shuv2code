import type { ThreadPurpose } from "@shuv2code/contracts";

export function isUserFacingThreadPurpose(purpose: ThreadPurpose | undefined): boolean {
  return purpose === undefined || purpose === "standard";
}

export function isUserFacingThreadShell(
  thread: Readonly<{ purpose?: ThreadPurpose | undefined }>,
): boolean {
  return isUserFacingThreadPurpose(thread.purpose);
}
