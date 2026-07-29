import * as NodeURL from "node:url";

import type {
  ChatAttachment,
  ProviderApprovalDecision,
  RuntimeMode,
  ServerProviderSkill,
} from "@shuv2code/contracts";
import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type Model,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@shuv2code/shared/Net";
import { HostProcessPlatform } from "@shuv2code/shared/hostProcess";
import { resolveSpawnCommand } from "@shuv2code/shared/shell";
import { createOpenCodeV2CompatibilityClient } from "./opencodeV2Compatibility.ts";
import { detectOpenCodeServerProtocol, requireOpenCodeV2Service } from "./opencodeV2Service.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const OPENCODE_EMPTY_CONFIG_CONTENT = "{}";

const OPENCODE_SERVER_READY_PREFIXES = ["opencode server listening", "server listening"] as const;
const OPENCODE_SERVER_PASSWORD_PREFIX = "server password ";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
export type OpenCodeProtocol = "v1" | "v2";
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
  readonly protocol: OpenCodeProtocol;
  readonly serverPassword?: string;
  /**
   * When true, this handle points at a shared background service that must not
   * be terminated when the caller's scope closes.
   */
  readonly sharedService?: boolean;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
  readonly protocol: OpenCodeProtocol;
  readonly serverPassword?: string;
  /**
   * True when shuv2code did not spawn a private process for this connection
   * (configured URL or discovered/ensured V2 background service).
   */
  readonly sharedService?: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

interface OpenCodeSkillInfo {
  readonly name: string;
  readonly description?: string;
  readonly location: string;
}

export function normalizeOpenCodeSkills(
  skills: ReadonlyArray<OpenCodeSkillInfo>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.flatMap((skill) => {
    const name = skill.name.trim();
    const path = skill.location.trim();
    if (!name || !path) return [];
    const description = skill.description?.trim();
    return [
      {
        name,
        path,
        enabled: true,
        ...(description ? { description } : {}),
      },
    ];
  });
}

export function loadOpenCodeSkills(
  client: OpencodeClient,
): Effect.Effect<ReadonlyArray<ServerProviderSkill>, OpenCodeRuntimeError> {
  const skills = (
    client.app as unknown as {
      readonly skills?: () => Promise<{ readonly data?: ReadonlyArray<OpenCodeSkillInfo> }>;
    }
  ).skills;
  if (typeof skills !== "function") return Effect.succeed([]);
  return runOpenCodeSdk("app.skills", () => skills.call(client.app)).pipe(
    Effect.map((result) => normalizeOpenCodeSkills(result.data ?? [])),
  );
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly protocol?: OpenCodeProtocol;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadInventoryFromCli: (input: {
    readonly binaryPath: string;
    readonly directory?: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
}

/** @internal */
export function parseOpenCodeServerUrl(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!OPENCODE_SERVER_READY_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

/** @internal */
export function parseOpenCodeServerPassword(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith(OPENCODE_SERVER_PASSWORD_PREFIX)) {
      return line.slice(OPENCODE_SERVER_PASSWORD_PREFIX.length).trim() || null;
    }
  }
  return null;
}

export function detectOpenCodeProtocolFromVersionOutput(output: string): OpenCodeProtocol {
  const normalized = output.trim().toLowerCase();
  const version = normalized.match(/\b(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?\b/);
  if (version?.[1] !== undefined && Number(version[1]) >= 2) {
    return "v2";
  }
  // OpenCode beta/channel builds ship as 0.0.0-<channel>-<stamp> (e.g. next, local).
  if (version?.[1] === "0" && version[2] === "0" && version[3] === "0" && version[4]) {
    return "v2";
  }
  return "v1";
}

const SLUG_LINE_RE = /^(\S+\/\S+)\s*$/;
const AGENT_HEADER_RE = /^(.+)\s+\((\S+)\)\s*$/;

// Agents that are always hidden in OpenCode but the CLI "agent list" command
// does not expose the hidden flag. Keep in sync with OpenCode agent
// definitions (in the OpenCode repo: packages/opencode/src/agent/agent.ts).
const KNOWN_HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);

/** @internal */
export function parseModelsCliOutput(stdout: string): {
  readonly providers: ReadonlyMap<
    string,
    { readonly id: string; readonly name: string; readonly models: { [key: string]: Model } }
  >;
  readonly connected: ReadonlyArray<string>;
} {
  const providers = new Map<
    string,
    { id: string; name: string; models: { [key: string]: Model } }
  >();
  const lines = stdout.split("\n");
  let currentSlug: string | null = null;
  const jsonLines: Array<string> = [];

  const flushModel = () => {
    if (currentSlug !== null && jsonLines.length > 0) {
      const jsonStr = jsonLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const model = JSON.parse(jsonStr) as Model;
          const separator = currentSlug.indexOf("/");
          if (separator > 0) {
            const providerID = currentSlug.slice(0, separator);
            const modelID = currentSlug.slice(separator + 1);
            let provider = providers.get(providerID);
            if (!provider) {
              provider = { id: providerID, name: providerID, models: {} };
              providers.set(providerID, provider);
            }
            provider.models[modelID] = model;
          }
        } catch {
          // Skip unparseable model JSON
        }
      }
    }
    currentSlug = null;
    jsonLines.length = 0;
  };

  for (const line of lines) {
    const slugMatch = SLUG_LINE_RE.exec(line);
    if (slugMatch) {
      flushModel();
      currentSlug = slugMatch[1]!;
    } else if (currentSlug !== null) {
      jsonLines.push(line);
    }
  }
  flushModel();

  return { providers, connected: [...providers.keys()] };
}

/** @internal */
export function parseAgentListCliOutput(stdout: string): ReadonlyArray<Agent> {
  const agents: Array<Agent> = [];
  const lines = stdout.split("\n");
  let currentHeader: { name: string; mode: string } | null = null;
  const blockLines: Array<string> = [];

  const flushAgent = () => {
    if (currentHeader !== null) {
      const jsonStr = blockLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const permission = JSON.parse(jsonStr);
          agents.push({
            name: currentHeader.name,
            mode: currentHeader.mode as Agent["mode"],
            hidden: KNOWN_HIDDEN_AGENTS.has(currentHeader.name),
            permission,
            options: {},
          });
        } catch {
          // Skip unparseable agent
        }
      }
    }
    currentHeader = null;
    blockLines.length = 0;
  };

  for (const line of lines) {
    const match = AGENT_HEADER_RE.exec(line);
    if (match) {
      flushAgent();
      currentHeader = { name: match[1]!, mode: match[2]! };
    } else if (currentHeader !== null) {
      blockLines.push(line);
    }
  }
  flushAgent();

  return agents;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          shell: spawnCommand.shell,
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const versionResult = yield* runOpenCodeCommand({
        binaryPath: input.binaryPath,
        args: ["--version"],
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });
      const protocol = detectOpenCodeProtocolFromVersionOutput(versionResult.stdout);
      if (protocol === "v2") {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail:
            "OpenCode V2 does not use a private serve process. Connect to the running background service instead (`opencode service start`).",
        });
      }
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            ...(protocol === "v1"
              ? {
                  env: {
                    ...input.environment,
                    OPENCODE_CONFIG_CONTENT: OPENCODE_EMPTY_CONFIG_CONTENT,
                  },
                }
              : input.environment
                ? { env: input.environment }
                : {}),
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<
        { readonly url: string; readonly serverPassword?: string },
        OpenCodeRuntimeError
      >();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseOpenCodeServerUrl(nextStdout);
            const serverPassword = parseOpenCodeServerPassword(nextStdout);
            // V2 binaries never reach this spawn path (guarded above), so the
            // URL alone marks readiness; a password is captured if printed.
            if (!parsed) {
              return Effect.void;
            }
            return Deferred.succeed(readyDeferred, {
              url: parsed,
              ...(serverPassword ? { serverPassword } : {}),
            }).pipe(Effect.ignore);
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      // Startup-time fibers are no longer needed once ready has resolved (either
      // way). The exit fiber is only interrupted on failure; on success it keeps
      // the caller's `exitCode` effect observable until the scope closes.
      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      return {
        url: readyOption.value.url,
        protocol,
        ...(readyOption.value.serverPassword
          ? { serverPassword: readyOption.value.serverPassword }
          : {}),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      return Effect.gen(function* () {
        const protocol = yield* Effect.tryPromise({
          try: () =>
            detectOpenCodeServerProtocol({
              baseUrl: serverUrl,
              ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
            }),
          catch: (cause) =>
            new OpenCodeRuntimeError({
              operation: "connectToOpenCodeServer",
              detail: `Failed to detect OpenCode server protocol at ${serverUrl}: ${openCodeRuntimeErrorDetail(cause)}`,
              cause,
            }),
        });
        return {
          url: serverUrl,
          exitCode: null,
          external: true,
          sharedService: true,
          protocol,
          ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
        } satisfies OpenCodeServerConnection;
      });
    }

    return Effect.gen(function* () {
      const versionResult = yield* runOpenCodeCommand({
        binaryPath: input.binaryPath,
        args: ["--version"],
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });
      const protocol = detectOpenCodeProtocolFromVersionOutput(versionResult.stdout);
      if (protocol === "v2") {
        const version =
          versionResult.stdout.match(/\b(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ??
          undefined;
        // Attach only — never spawn a private V2 serve. Private servers lack
        // the background service's auth/model state.
        const endpoint = yield* Effect.tryPromise({
          try: () =>
            requireOpenCodeV2Service({
              ...(version ? { version } : {}),
              ...(input.environment !== undefined ? { environment: input.environment } : {}),
            }),
          catch: (cause) =>
            new OpenCodeRuntimeError({
              operation: "connectToOpenCodeServer",
              detail: `Failed to connect to OpenCode V2 background service: ${openCodeRuntimeErrorDetail(cause)}`,
              cause,
            }),
        });
        return {
          url: endpoint.url,
          exitCode: null,
          // Treat the user-managed background service like an external server
          // for lifecycle (do not kill) while still allowing shuv2code MCP registration.
          external: false,
          sharedService: true,
          protocol: "v2" as const,
          ...(endpoint.password ? { serverPassword: endpoint.password } : {}),
        } satisfies OpenCodeServerConnection;
      }

      const server = yield* startOpenCodeServerProcess({
        binaryPath: input.binaryPath,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      return {
        url: server.url,
        exitCode: server.exitCode,
        external: false,
        sharedService: false,
        protocol: server.protocol,
        ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
      } satisfies OpenCodeServerConnection;
    });
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    input.protocol === "v2"
      ? createOpenCodeV2CompatibilityClient(input)
      : createOpencodeClient({
          baseUrl: input.baseUrl,
          directory: input.directory,
          ...(input.serverPassword
            ? {
                headers: {
                  Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
                },
              }
            : {}),
          throwOnError: true,
        });

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", () => client.app.agents()).pipe(
      Effect.map((result) => result.data ?? []),
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client), loadOpenCodeSkills(client)], {
      concurrency: "unbounded",
    }).pipe(Effect.map(([providerList, agents, skills]) => ({ providerList, agents, skills })));

  const loadInventoryFromCli: OpenCodeRuntimeShape["loadInventoryFromCli"] = (input) =>
    Effect.gen(function* () {
      const env = input.environment !== undefined ? { environment: input.environment } : ({} as {});

      const versionResult = yield* runOpenCodeCommand({
        binaryPath: input.binaryPath,
        args: ["--version"],
        ...env,
      });
      if (detectOpenCodeProtocolFromVersionOutput(versionResult.stdout) === "v2") {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* connectToOpenCodeServer({
              binaryPath: input.binaryPath,
              ...env,
            });
            return yield* loadOpenCodeInventory(
              createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: input.directory ?? process.cwd(),
                protocol: server.protocol,
                ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
              }),
            );
          }),
        );
      }

      const runModelsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["models", "--verbose"],
          ...env,
        }).pipe(Effect.exit);
      const runAgentsCli = () =>
        runOpenCodeCommand({ binaryPath: input.binaryPath, args: ["agent", "list"], ...env }).pipe(
          Effect.exit,
        );

      // First attempt — run both in parallel
      let [modelsResult, agentsResult] = yield* Effect.all([runModelsCli(), runAgentsCli()], {
        concurrency: "unbounded",
      });

      // Retry once after 1s on transient failures (e.g. SQLite "database is locked")
      const needsModelsRetry = modelsResult._tag === "Failure" || modelsResult.value.code !== 0;
      const needsAgentsRetry = agentsResult._tag === "Failure" || agentsResult.value.code !== 0;
      if (needsModelsRetry || needsAgentsRetry) {
        yield* Effect.sleep("1 second");
        const [m2, a2] = yield* Effect.all(
          [
            needsModelsRetry ? runModelsCli() : Effect.succeed(modelsResult),
            needsAgentsRetry ? runAgentsCli() : Effect.succeed(agentsResult),
          ],
          { concurrency: "unbounded" },
        );
        modelsResult = m2;
        agentsResult = a2;
      }

      if (modelsResult._tag === "Failure") {
        const cause = Cause.squash(modelsResult.cause);
        return yield* ensureRuntimeError(
          "loadInventoryFromCli",
          `Failed to load OpenCode models: ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        );
      }
      if (modelsResult.value.code !== 0) {
        return yield* new OpenCodeRuntimeError({
          operation: "loadInventoryFromCli",
          detail: `OpenCode models command exited with code ${modelsResult.value.code}.`,
        });
      }

      const parsed = parseModelsCliOutput(modelsResult.value.stdout);
      const connected = [...parsed.connected];
      const allProviders: ProviderListResponse["all"] = [...parsed.providers.values()].map(
        (provider) => ({
          id: provider.id,
          name: provider.name,
          source: "config" as const,
          env: [],
          options: {},
          models: provider.models,
        }),
      );

      // Agent metadata enriches model capabilities but is not required for an
      // authoritative model inventory, so it may still degrade to an empty list.
      let agents: ReadonlyArray<Agent> = [];
      if (agentsResult._tag === "Success" && agentsResult.value.code === 0) {
        agents = parseAgentListCliOutput(agentsResult.value.stdout);
      }

      return {
        providerList: { all: allProviders, default: {}, connected },
        agents,
        skills: [],
      };
    });

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadInventoryFromCli,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "shuv2code/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
