import {
  AuthAdeApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@shuv2code/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("separates automation observation from mutation", () => {
    for (const method of [
      WS_METHODS.automationsList,
      WS_METHODS.automationsGet,
      WS_METHODS.automationsListRuns,
      WS_METHODS.automationsValidateSchedule,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.automationsCreate,
      WS_METHODS.automationsUpdate,
      WS_METHODS.automationsDelete,
      WS_METHODS.automationsRunNow,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
  it("separates looking at the fleet from changing it", () => {
    for (const method of [
      WS_METHODS.adeGetRoster,
      WS_METHODS.adeGetBot,
      WS_METHODS.adeGetNeedsYouCount,
      WS_METHODS.adeListNeedsYou,
      WS_METHODS.adeGetNeedsYouItem,
      WS_METHODS.subscribeAdeFleetHealth,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.adeCreateBotFromTemplate,
      WS_METHODS.adeCreateProject,
      WS_METHODS.adeWriteBotMemory,
      WS_METHODS.adeEditBotPersona,
      WS_METHODS.adeSetBotComputerUse,
      // Starting a chat mints a kernel session; it is not a read.
      WS_METHODS.adeStartBotChat,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  /**
   * Captain authority is its own scope (spec §5, ADR §10.4): organizing the
   * fleet and *deciding* on its behalf are different powers, and a client that
   * can do the first must not silently gain the second.
   */
  it("holds the approval verdict apart from every other ADE mutation", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.adeSubmitNeedsYouDecision)).toBe(
      AuthAdeApproveScope,
    );
    expect(
      Object.entries(RPC_REQUIRED_SCOPES).filter(([, scope]) => scope === AuthAdeApproveScope),
    ).toEqual([[WS_METHODS.adeSubmitNeedsYouDecision, AuthAdeApproveScope]]);
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
