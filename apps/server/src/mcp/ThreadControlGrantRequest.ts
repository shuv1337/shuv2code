import { ApprovalRequestId, type OrchestrationThreadActivity } from "@shuv2code/contracts";

export const THREAD_CONTROL_GRANT_REQUEST_ID_PREFIX = "thread-control-grant:";
export const THREAD_CONTROL_GRANT_REQUEST_TYPE = "thread_control_grant";
export const THREAD_CONTROL_GRANT_REQUEST_KIND = "thread-control";

export const makeThreadControlGrantRequestId = (uuid: string) =>
  ApprovalRequestId.make(`${THREAD_CONTROL_GRANT_REQUEST_ID_PREFIX}${uuid}`);

export function isThreadControlGrantApproval(
  activity: OrchestrationThreadActivity,
  requestId: string,
): boolean {
  if (
    activity.kind !== "approval.requested" ||
    typeof activity.payload !== "object" ||
    activity.payload === null
  ) {
    return false;
  }
  const payload = activity.payload as Record<string, unknown>;
  return (
    requestId.startsWith(THREAD_CONTROL_GRANT_REQUEST_ID_PREFIX) &&
    payload.requestId === requestId &&
    payload.requestType === THREAD_CONTROL_GRANT_REQUEST_TYPE &&
    payload.requestKind === THREAD_CONTROL_GRANT_REQUEST_KIND
  );
}
