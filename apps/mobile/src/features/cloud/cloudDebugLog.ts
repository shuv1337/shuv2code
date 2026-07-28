export function isCloudDebugEnabled(): boolean {
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { __SHUV2CODE_CLOUD_DEBUG__?: boolean }).__SHUV2CODE_CLOUD_DEBUG__ === true)
  );
}

export function cloudDebugLog(event: string, data?: Record<string, unknown>): void {
  if (!isCloudDebugEnabled()) {
    return;
  }
  if (data) {
    console.log(`[shuv2code-cloud] ${event}`, data);
  } else {
    console.log(`[shuv2code-cloud] ${event}`);
  }
}
