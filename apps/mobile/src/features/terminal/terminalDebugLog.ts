/**
 * Debug logging for the mobile terminal pipeline. Prefix: `[shuv2code-terminal]`.
 *
 * Enabled when `__DEV__` is true, or set `globalThis.__SHUV2CODE_TERMINAL_DEBUG__ = true` in a JS
 * debugger / Metro console to trace release/TestFlight builds.
 */
export function isTerminalDebugEnabled(): boolean {
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { __SHUV2CODE_TERMINAL_DEBUG__?: boolean }).__SHUV2CODE_TERMINAL_DEBUG__ ===
        true)
  );
}

export function terminalDebugLog(message: string, data?: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  if (data !== undefined) {
    console.log(`[shuv2code-terminal] ${message}`, data);
  } else {
    console.log(`[shuv2code-terminal] ${message}`);
  }
}
