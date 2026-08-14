import { resolveSpawnCommand } from "@shuv2code/shared/shell";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import type { ProviderThreadHistoryPreparationResult } from "../Services/ProviderAdapter.ts";

const OUTPUT_MAX_BYTES = 128 * 1024;
const MIGRATION_TIMEOUT = Duration.minutes(30);

const statuses = [
  "eligible",
  "migrated",
  "already_paginated",
  "skipped_empty",
  "skipped_busy",
  "failed",
] as const;
type MigrationStatus = (typeof statuses)[number];

interface MigrationOutcome {
  readonly thread_id: string | null;
  readonly status: MigrationStatus;
  readonly bytes_processed: number;
  readonly message?: string | null;
}

interface MigrationReport {
  readonly outcomes: ReadonlyArray<MigrationOutcome>;
}

export class CodexThreadHistoryPreparationError extends Data.TaggedError(
  "CodexThreadHistoryPreparationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexRolloutMigrationReport(text: string): MigrationReport | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.outcomes)) return undefined;
  const outcomes: MigrationOutcome[] = [];
  for (const raw of decoded.outcomes) {
    if (!isRecord(raw)) return undefined;
    const threadId = raw.thread_id;
    const status = raw.status;
    const bytesProcessed = raw.bytes_processed;
    const message = raw.message;
    if (
      !((typeof threadId === "string" && threadId.length > 0) || threadId === null) ||
      typeof status !== "string" ||
      !statuses.includes(status as MigrationStatus) ||
      typeof bytesProcessed !== "number" ||
      !Number.isSafeInteger(bytesProcessed) ||
      bytesProcessed < 0 ||
      !(
        message === undefined ||
        message === null ||
        (typeof message === "string" && message.length > 0)
      )
    ) {
      return undefined;
    }
    outcomes.push({
      thread_id: threadId,
      status: status as MigrationStatus,
      bytes_processed: bytesProcessed,
      ...(typeof message === "string" ? { message } : {}),
    });
  }
  return { outcomes };
}

export function interpretCodexRolloutMigrationReport(input: {
  readonly report: MigrationReport;
  readonly providerThreadId: string;
  readonly action: "inspect" | "migrate";
}): ProviderThreadHistoryPreparationResult {
  const outcome = input.report.outcomes.find(
    (candidate) => candidate.thread_id === input.providerThreadId,
  );
  if (outcome === undefined) {
    return { state: "not-found", message: "Codex did not find the selected persisted thread." };
  }
  switch (outcome.status) {
    case "already_paginated":
    case "migrated":
      return { state: "ready", historyMode: "paginated" };
    case "skipped_empty":
      return { state: "ready", historyMode: "not-applicable" };
    case "eligible":
      return input.action === "inspect"
        ? { state: "migration-required", bytesToProcess: outcome.bytes_processed }
        : {
            state: "not-found",
            message: "Codex inspected the thread but did not publish its migration.",
          };
    case "skipped_busy":
      return {
        state: "busy",
        message: outcome.message ?? "Codex is currently using the selected thread.",
      };
    case "failed":
      return {
        state: "not-found",
        message: outcome.message ?? "Codex could not migrate the selected thread.",
      };
  }
}

function isUnsupportedCommand(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("migrate-rollouts") &&
    (normalized.includes("unrecognized subcommand") ||
      normalized.includes("unknown command") ||
      normalized.includes("unexpected argument"))
  );
}

export const runCodexThreadHistoryPreparation = Effect.fn("CodexThreadHistoryPreparation.run")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly providerThreadId: string;
    readonly action: "inspect" | "migrate";
  }) {
    const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
    const environment = {
      ...input.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const args = [
      "migrate-rollouts",
      ...(input.action === "migrate" ? ["--apply"] : []),
      "--thread",
      input.providerThreadId,
      "--json",
    ];
    const attempted = yield* Effect.scoped(
      Effect.gen(function* () {
        const command = yield* resolveSpawnCommand(input.binaryPath, args, {
          env: environment,
          extendEnv: input.environment === undefined,
        });
        const child = yield* input.spawner.spawn(
          ChildProcess.make(command.command, command.args, {
            cwd: input.cwd,
            env: environment,
            extendEnv: input.environment === undefined,
            shell: command.shell,
          }),
        );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: OUTPUT_MAX_BYTES }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: OUTPUT_MAX_BYTES }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout: stdout.text, stderr: stderr.text, exitCode: Number(exitCode) };
      }),
    ).pipe(Effect.timeoutOption(MIGRATION_TIMEOUT));

    if (Option.isNone(attempted)) {
      return yield* new CodexThreadHistoryPreparationError({
        message: "Codex did not finish preparing the selected thread within 30 minutes.",
      });
    }
    const { stdout, stderr, exitCode } = attempted.value;
    if (isUnsupportedCommand(stderr)) {
      return {
        state: "unsupported" as const,
        message: "This Codex version cannot migrate legacy threads.",
      };
    }
    const report = parseCodexRolloutMigrationReport(stdout);
    if (report === undefined) {
      return yield* new CodexThreadHistoryPreparationError({
        message:
          exitCode === 0
            ? "Codex returned an invalid thread migration report."
            : `Codex thread preparation failed${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : "."}`,
      });
    }
    return interpretCodexRolloutMigrationReport({
      report,
      providerThreadId: input.providerThreadId,
      action: input.action,
    });
  },
);
