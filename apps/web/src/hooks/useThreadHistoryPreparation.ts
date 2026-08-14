import type {
  EnvironmentId,
  ProviderThreadHistoryPreparationResult,
  ThreadId,
} from "@shuv2code/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useState } from "react";

import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "../state/entities";
import { threadEnvironment } from "../state/threads";

export type ThreadHistoryPreparationState =
  | { readonly type: "checking" }
  | { readonly type: "migrating" }
  | { readonly type: "ready" }
  | { readonly type: "cancelled" }
  | { readonly type: "error"; readonly message: string };

const verified = new Set<string>();
const inspections = new Map<string, Promise<ProviderThreadHistoryPreparationResult>>();

function keyOf(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}\u0000${threadId}`;
}

async function runPreparation(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  action: "inspect" | "migrate",
): Promise<ProviderThreadHistoryPreparationResult> {
  const result = await threadEnvironment.prepareHistory.run(appAtomRegistry, {
    environmentId,
    input: { threadId, action },
  });
  if (result._tag === "Success") return result.value;
  throw Cause.squash(result.cause);
}

function inspectOnce(environmentId: EnvironmentId, threadId: ThreadId) {
  const key = keyOf(environmentId, threadId);
  const current = inspections.get(key);
  if (current) return current;
  const next = runPreparation(environmentId, threadId, "inspect").finally(() => {
    inspections.delete(key);
  });
  inspections.set(key, next);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "This thread could not be prepared.";
}

export function useThreadHistoryPreparation(
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly threadTitle: string;
  } | null,
): ThreadHistoryPreparationState & { readonly retry: () => void } {
  const key = input ? keyOf(input.environmentId, input.threadId) : "none";
  const environmentId = input?.environmentId;
  const threadId = input?.threadId;
  const threadTitle = input?.threadTitle;
  const serverConfigs = useServerConfigs();
  const serverConfig = environmentId === undefined ? undefined : serverConfigs.get(environmentId);
  const supportsPreparation =
    serverConfig?.environment.capabilities.threadHistoryPreparation === true;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ThreadHistoryPreparationState>(() =>
    input === null || verified.has(key) ? { type: "ready" } : { type: "checking" },
  );
  const retry = useCallback(() => {
    setState({ type: "checking" });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    if (input === null) {
      setState({ type: "ready" });
      return () => {
        active = false;
      };
    }
    if (verified.has(key)) {
      setState({ type: "ready" });
      return () => {
        active = false;
      };
    }
    if (serverConfig === undefined) {
      setState({ type: "checking" });
      return () => {
        active = false;
      };
    }
    if (!supportsPreparation) {
      setState({ type: "ready" });
      return () => {
        active = false;
      };
    }
    setState({ type: "checking" });
    void inspectOnce(input.environmentId, input.threadId)
      .then(async (inspected) => {
        if (!active) return;
        if (inspected.state === "unsupported") {
          // Older Codex builds cannot inspect history mode. Preserve existing
          // behavior rather than making every thread unloadable.
          verified.add(key);
          setState({ type: "ready" });
          return;
        }
        if (inspected.state !== "migration-required") {
          if (inspected.state === "ready") {
            verified.add(key);
            setState({ type: "ready" });
          } else {
            setState({ type: "error", message: inspected.message });
          }
          return;
        }
        const confirmed = await ensureLocalApi().dialogs.confirm(
          [
            `Update “${input.threadTitle}” to the current thread format?`,
            "",
            "This legacy Codex thread needs a one-time migration before Shuv can load it efficiently.",
            "",
            "Codex will rewrite only this thread's persisted rollout as paginated history. No other threads will be changed.",
          ].join("\n"),
        );
        if (!active) return;
        if (!confirmed) {
          setState({ type: "cancelled" });
          return;
        }
        setState({ type: "migrating" });
        const migrated = await runPreparation(input.environmentId, input.threadId, "migrate");
        if (!active) return;
        if (migrated.state === "ready") {
          verified.add(key);
          setState({ type: "ready" });
        } else {
          setState({
            type: "error",
            message:
              migrated.state === "migration-required"
                ? "Codex did not verify the migrated thread."
                : migrated.message,
          });
        }
      })
      .catch((error) => {
        if (active) setState({ type: "error", message: errorMessage(error) });
      });
    return () => {
      active = false;
    };
  }, [attempt, environmentId, key, serverConfig, supportsPreparation, threadId, threadTitle]);

  return { ...state, retry };
}
