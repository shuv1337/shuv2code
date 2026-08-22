import {
  type CanonicalRequestType,
  EventId,
  type OpenCodeV2Settings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@shuv2code/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  OpenCodeRuntime,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
} from "../opencodeRuntime.ts";
import {
  createOpenCodeV2Client,
  type OpenCodeV2Client,
  type OpenCodeV2Event,
  type OpenCodeV2SessionInfo,
} from "../opencodeV2Client.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { toToolLifecycleItemType } from "./toolLifecycleItemType.ts";

const PROVIDER = ProviderDriverKind.make("opencodeV2");
const OPENCODE_V2_RESUME_KIND = "opencode-v2" as const;
const OPENCODE_V2_RESUME_VERSION = 1 as const;
const MISSING_TERMINAL_RECOVERY_LIMIT = 2;

export type OpenCodeV2AdapterError =
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError;

const NonEmptyString = Schema.Trim.check(Schema.isNonEmpty());

const OpenCodeV2ResumeCursorSchema = Schema.Struct({
  kind: Schema.Literal(OPENCODE_V2_RESUME_KIND),
  schemaVersion: Schema.Literal(OPENCODE_V2_RESUME_VERSION),
  sessionId: NonEmptyString,
  activeTurnId: Schema.optional(NonEmptyString),
});

const OpenCodeV2FormOptionSchema = Schema.Struct({
  value: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const OpenCodeV2FormFieldSchema = Schema.Struct({
  key: NonEmptyString,
  type: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  custom: Schema.optional(Schema.Boolean),
  when: Schema.optional(Schema.Unknown),
  options: Schema.optional(Schema.Array(OpenCodeV2FormOptionSchema)),
});

const OpenCodeV2FormSchema = Schema.Struct({
  id: NonEmptyString,
  sessionID: NonEmptyString,
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(Schema.String),
    }),
  ),
  fields: Schema.optional(Schema.Array(OpenCodeV2FormFieldSchema)),
});

const OpenCodeV2PermissionSchema = Schema.Struct({
  id: NonEmptyString,
  sessionID: Schema.optional(NonEmptyString),
  action: Schema.optional(NonEmptyString),
  resources: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.Unknown),
});

const OpenCodeV2PermissionReplySchema = Schema.Struct({
  requestID: NonEmptyString,
  reply: Schema.Literals(["once", "always", "reject"]),
});

const OpenCodeV2FormReplySchema = Schema.Struct({
  id: NonEmptyString,
  answer: Schema.Record(Schema.String, Schema.Unknown),
});

const OpenCodeV2FormCancelledSchema = Schema.Struct({
  id: NonEmptyString,
});

type OpenCodeV2ResumeCursor = typeof OpenCodeV2ResumeCursorSchema.Type;
type OpenCodeV2FormField = typeof OpenCodeV2FormFieldSchema.Type;
type OpenCodeV2Form = typeof OpenCodeV2FormSchema.Type;
type OpenCodeV2Permission = typeof OpenCodeV2PermissionSchema.Type;

export const decodeOpenCodeV2ResumeCursor = Schema.decodeUnknownEffect(
  OpenCodeV2ResumeCursorSchema,
);
const decodeOpenCodeV2ResumeCursorOption = Schema.decodeUnknownOption(OpenCodeV2ResumeCursorSchema);
export const decodeOpenCodeV2Form = Schema.decodeUnknownEffect(OpenCodeV2FormSchema);
export const decodeOpenCodeV2Permission = Schema.decodeUnknownEffect(OpenCodeV2PermissionSchema);
export const decodeOpenCodeV2PermissionReply = Schema.decodeUnknownEffect(
  OpenCodeV2PermissionReplySchema,
);
export const decodeOpenCodeV2FormReply = Schema.decodeUnknownEffect(OpenCodeV2FormReplySchema);
const decodeOpenCodeV2FormCancelled = Schema.decodeUnknownEffect(OpenCodeV2FormCancelledSchema);

interface OpenCodeV2SessionContext {
  session: ProviderSession;
  readonly client: OpenCodeV2Client;
  readonly directory: string;
  readonly canRegisterMcpServers: boolean;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, OpenCodeV2Permission>;
  readonly pendingForms: Map<string, OpenCodeV2Form>;
  readonly seenRequestIds: Set<string>;
  readonly resolvedRequestIds: Set<string>;
  readonly toolNameById: Map<string, string>;
  readonly toolInputById: Map<string, unknown>;
  readonly emittedTextByItemId: Map<string, string>;
  activeTurnId: TurnId | undefined;
  missingTerminalRecoveryAttempts: number;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function openCodeV2ToolCallId(data: Record<string, unknown>): string | undefined {
  return asString(data.callID) ?? asString(data.id);
}

function openCodeV2ContentItemId(
  data: Record<string, unknown>,
  streamKind: "assistant_text" | "reasoning_text",
): string {
  const messageId = asString(data.assistantMessageID) ?? "msg";
  const ordinal = String(data.ordinal ?? 0);
  return `${messageId}:${streamKind}:${ordinal}`;
}

interface OpenCodeV2ProjectedTool {
  readonly name: string;
  readonly input?: unknown;
}

function recoverProjectedTools(payload: unknown): Map<string, OpenCodeV2ProjectedTool> {
  const tools = new Map<string, OpenCodeV2ProjectedTool>();
  const response = asRecord(payload);
  const messages = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.items)
      ? response.items
      : [];
  for (const message of messages) {
    const projected = asRecord(message);
    const entries = Array.isArray(projected?.content)
      ? projected.content
      : Array.isArray(projected?.parts)
        ? projected.parts
        : [];
    for (const entry of entries) {
      const tool = asRecord(entry);
      if (tool?.type !== "tool") continue;
      const id = asString(tool.id) ?? asString(tool.callID);
      const name = asString(tool.name) ?? asString(tool.tool);
      const state = asRecord(tool.state);
      const input = state?.input ?? tool.input;
      if (id && name) {
        tools.set(id, {
          name,
          ...(input === undefined ? {} : { input }),
        });
      }
    }
  }
  return tools;
}

async function recoverAllProjectedTools(
  client: OpenCodeV2Client,
  sessionID: string,
): Promise<Map<string, OpenCodeV2ProjectedTool>> {
  const tools = new Map<string, OpenCodeV2ProjectedTool>();
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < 1_000; pageCount++) {
    const page = await client.session.messages(sessionID, cursor ? { cursor } : undefined);
    for (const [id, tool] of recoverProjectedTools(page)) {
      if (!tools.has(id)) tools.set(id, tool);
    }
    const next = asString(page.cursor?.next);
    if (!next || visitedCursors.has(next)) break;
    visitedCursors.add(next);
    cursor = next;
  }
  return tools;
}

async function recoverProjectedTool(
  client: OpenCodeV2Client,
  sessionID: string,
  toolId: string,
): Promise<OpenCodeV2ProjectedTool | undefined> {
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < 1_000; pageCount++) {
    const page = await client.session.messages(sessionID, cursor ? { cursor } : undefined);
    const tool = recoverProjectedTools(page).get(toolId);
    if (tool) return tool;
    const next = asString(page.cursor?.next);
    if (!next || visitedCursors.has(next)) break;
    visitedCursors.add(next);
    cursor = next;
  }
  return undefined;
}

function isoFromEpochMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

function parseResumeCursor(raw: unknown): OpenCodeV2ResumeCursor | undefined {
  return decodeOpenCodeV2ResumeCursorOption(raw).pipe(Option.getOrUndefined);
}

function makeResumeCursor(input: {
  readonly sessionId: string;
  readonly activeTurnId?: string;
}): OpenCodeV2ResumeCursor {
  return {
    kind: OPENCODE_V2_RESUME_KIND,
    schemaVersion: OPENCODE_V2_RESUME_VERSION,
    sessionId: input.sessionId,
    ...(input.activeTurnId ? { activeTurnId: input.activeTurnId } : {}),
  };
}

export function openCodeV2EventSessionId(event: OpenCodeV2Event): string | undefined {
  const data = asRecord(event.data);
  if (!data) return undefined;
  return (
    asString(data.sessionID) ??
    asString(asRecord(data.form)?.sessionID) ??
    asString(asRecord(data.info)?.id)
  );
}

function isRepresentableField(field: OpenCodeV2FormField, questionForm: boolean): boolean {
  if (field.when !== undefined) return false;
  if (field.type === "multiselect" || field.type === "string" || field.type === undefined) {
    return questionForm || field.custom !== false;
  }
  return false;
}

export function mapOpenCodeV2FormToQuestions(
  form: OpenCodeV2Form,
): ReadonlyArray<UserInputQuestion> {
  const questionForm = form.metadata?.kind === "question";
  const fallback = form.title?.trim() || form.id;
  return (form.fields ?? [])
    .filter((field) => isRepresentableField(field, questionForm))
    .map((field) => {
      const header = field.title?.trim() || fallback || field.key;
      const question = field.description?.trim() || field.title?.trim() || fallback || field.key;
      return {
        id: field.key,
        header,
        question,
        options: (field.options ?? []).flatMap((option) => {
          const label = option.label?.trim();
          if (!label) return [];
          return [
            {
              label,
              description: option.description?.trim() || label,
            },
          ];
        }),
        multiSelect: field.type === "multiselect",
      } satisfies UserInputQuestion;
    });
}

export function toOpenCodeV2FormAnswer(
  form: OpenCodeV2Form,
  answers: ProviderUserInputAnswers,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of form.fields ?? []) {
    const raw = answers[field.key];
    if (raw === undefined) continue;
    const valuesByLabel = new Map(
      (field.options ?? []).flatMap((option) => {
        const label = option.label?.trim();
        if (!label) return [];
        return [[label, option.value ?? label] as const];
      }),
    );
    const toValue = (value: string) => valuesByLabel.get(value) ?? value;
    out[field.key] = Array.isArray(raw)
      ? raw.map((value) => (typeof value === "string" ? toValue(value) : value))
      : typeof raw === "string"
        ? toValue(raw)
        : raw;
  }
  return out;
}

export function mapOpenCodeV2PermissionToRequestType(
  action: string | undefined,
): CanonicalRequestType {
  switch (action) {
    case "bash":
    case "shell":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "write":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

function toPermissionReply(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    default:
      return "reject";
  }
}

function sessionErrorMessage(error: unknown): string {
  const record = asRecord(error);
  return asString(record?.message) ?? "OpenCode v2 session failed.";
}

function isMissingTerminalFinishError(error: unknown): boolean {
  const record = asRecord(error);
  return (
    record?.type === "provider.invalid-output" &&
    sessionErrorMessage(error).includes("without a terminal finish event")
  );
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export function makeOpenCodeV2Adapter(
  settings: OpenCodeV2Settings,
  options?: {
    readonly instanceId?: ProviderInstanceId;
    readonly environment?: NodeJS.ProcessEnv;
    readonly clientFactory?: (input: {
      readonly baseUrl: string;
      readonly directory: string;
      readonly serverPassword?: string;
    }) => OpenCodeV2Client;
  },
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencodeV2");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeV2SessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate opencode2 runtime identifier.",
            cause,
          }),
      ),
    );
    const createClient =
      options?.clientFactory ??
      ((input: {
        readonly baseUrl: string;
        readonly directory: string;
        readonly serverPassword?: string;
      }) => createOpenCodeV2Client(input));

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const invalidEventPayload =
      (context: OpenCodeV2SessionContext, event: OpenCodeV2Event) => (cause: unknown) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: `Invalid ${event.type} payload.`,
          cause,
        });

    const buildEventBase = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly createdAt?: string | undefined;
      readonly raw?: unknown;
    }) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? { raw: { source: "opencode.sdk.event" as const, payload: input.raw } }
            : {}),
        })),
      );

    const ensureSession = (threadId: ThreadId) => {
      const session = sessions.get(threadId);
      return session
        ? Effect.succeed(session)
        : new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    };

    const writeResume = (context: OpenCodeV2SessionContext, clearActiveTurnId = false) => {
      context.session = {
        ...context.session,
        resumeCursor: makeResumeCursor({
          sessionId: context.openCodeSessionId,
          ...(clearActiveTurnId || context.activeTurnId === undefined
            ? {}
            : { activeTurnId: String(context.activeTurnId) }),
        }),
      };
    };

    const emitFormRequested = Effect.fn("emitFormRequested")(function* (
      context: OpenCodeV2SessionContext,
      form: OpenCodeV2Form,
      raw?: unknown,
    ) {
      if (form.sessionID === "global") return;
      const questions = mapOpenCodeV2FormToQuestions(form);
      if (questions.length === 0) return;
      if (context.seenRequestIds.has(form.id)) return;
      context.seenRequestIds.add(form.id);
      context.pendingForms.set(form.id, form);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: form.id,
          raw,
        })),
        type: "user-input.requested",
        payload: { questions },
      });
    });

    const emitFormResolved = Effect.fn("emitFormResolved")(function* (
      context: OpenCodeV2SessionContext,
      formId: string,
      answers: Record<string, unknown>,
      raw?: unknown,
    ) {
      if (context.resolvedRequestIds.has(formId)) return;
      context.resolvedRequestIds.add(formId);
      context.pendingForms.delete(formId);
      context.seenRequestIds.add(formId);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: formId,
          raw,
        })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

    const emitPermissionOpened = Effect.fn("emitPermissionOpened")(function* (
      context: OpenCodeV2SessionContext,
      permission: OpenCodeV2Permission,
      raw?: unknown,
    ) {
      if (context.seenRequestIds.has(permission.id)) return;
      context.seenRequestIds.add(permission.id);
      context.pendingPermissions.set(permission.id, permission);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: permission.id,
          raw,
        })),
        type: "request.opened",
        payload: {
          requestType: mapOpenCodeV2PermissionToRequestType(permission.action),
          detail: permission.resources?.join("\n") ?? permission.action,
          args: permission.metadata,
        },
      });
      if (context.session.runtimeMode !== "full-access") return;

      yield* Effect.tryPromise({
        try: () =>
          context.client.permission.reply(context.openCodeSessionId, permission.id, "always"),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      context.pendingPermissions.delete(permission.id);
      context.resolvedRequestIds.add(permission.id);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: permission.id,
          raw,
        })),
        type: "request.resolved",
        payload: {
          requestType: mapOpenCodeV2PermissionToRequestType(permission.action),
          decision: "acceptForSession",
        },
      });
    });

    const handleEvent = Effect.fn("handleOpenCodeV2Event")(function* (
      context: OpenCodeV2SessionContext,
      event: OpenCodeV2Event,
    ) {
      const sessionId = openCodeV2EventSessionId(event);
      if (sessionId !== undefined && sessionId !== context.openCodeSessionId) {
        return;
      }
      const data = asRecord(event.data) ?? {};
      const createdAt = isoFromEpochMs(event.created);
      const turnId = context.activeTurnId;

      switch (event.type) {
        case "session.renamed": {
          const title = asString(data.title);
          if (!title) break;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              createdAt,
              raw: event,
            })),
            type: "thread.metadata.updated",
            payload: { name: title },
          });
          break;
        }
        case "session.execution.started": {
          const nextTurnId = turnId ?? TurnId.make(`opencode2-turn-${yield* randomUUIDv4}`);
          context.activeTurnId = nextTurnId;
          context.session = { ...context.session, status: "running", activeTurnId: nextTurnId };
          writeResume(context);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: nextTurnId,
              createdAt,
              raw: event,
            })),
            type: "turn.started",
            payload: { model: context.session.model },
          });
          break;
        }
        case "session.execution.succeeded": {
          const completedTurnId = context.activeTurnId;
          context.missingTerminalRecoveryAttempts = 0;
          context.activeTurnId = undefined;
          const { activeTurnId: _activeTurnId, ...settledSession } = context.session;
          context.session = { ...settledSession, status: "ready" };
          writeResume(context, true);
          if (completedTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: completedTurnId,
                createdAt,
                raw: event,
              })),
              type: "turn.completed",
              payload: { state: "completed" },
            });
          }
          break;
        }
        case "session.execution.failed": {
          const failedTurnId = context.activeTurnId;
          const message = sessionErrorMessage(data.error);
          if (
            failedTurnId &&
            isMissingTerminalFinishError(data.error) &&
            context.missingTerminalRecoveryAttempts < MISSING_TERMINAL_RECOVERY_LIMIT
          ) {
            const attempt = context.missingTerminalRecoveryAttempts + 1;
            const recovery = yield* Effect.exit(
              Effect.tryPromise({
                try: () =>
                  context.client.session.synthetic(context.openCodeSessionId, {
                    text: [
                      "The provider stream ended before sending a terminal finish event.",
                      "Continue the interrupted response from the current durable session state.",
                      "Do not repeat completed tool calls or other completed work.",
                      "If the response was already complete, finish cleanly.",
                    ].join(" "),
                    description: "Automatically recover an interrupted provider stream",
                    metadata: {
                      shuv2code: {
                        kind: "provider-stream-recovery",
                        attempt,
                      },
                    },
                    delivery: "steer",
                    resume: true,
                  }),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.synthetic",
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              }),
            );
            if (Exit.isSuccess(recovery)) {
              context.missingTerminalRecoveryAttempts = attempt;
              context.session = { ...context.session, status: "running" };
              writeResume(context);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId: failedTurnId,
                  createdAt,
                  raw: event,
                })),
                type: "runtime.warning",
                payload: {
                  message: `Provider stream ended early; recovering automatically (${attempt}/${MISSING_TERMINAL_RECOVERY_LIMIT}).`,
                  detail: data.error,
                },
              });
              break;
            }
            yield* Effect.logWarning("OpenCode v2 automatic stream recovery failed", {
              threadId: context.session.threadId,
              sessionId: context.openCodeSessionId,
              attempt,
              cause: recovery.cause,
            });
          }
          context.missingTerminalRecoveryAttempts = 0;
          context.activeTurnId = undefined;
          const { activeTurnId: _activeTurnId, ...settledSession } = context.session;
          context.session = { ...settledSession, status: "ready" };
          writeResume(context, true);
          if (failedTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: failedTurnId,
                createdAt,
                raw: event,
              })),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: message },
            });
          }
          break;
        }
        case "session.execution.interrupted": {
          const interruptedTurnId = context.activeTurnId;
          context.missingTerminalRecoveryAttempts = 0;
          context.activeTurnId = undefined;
          const { activeTurnId: _activeTurnId, ...settledSession } = context.session;
          context.session = { ...settledSession, status: "ready" };
          writeResume(context, true);
          if (interruptedTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: interruptedTurnId,
                createdAt,
                raw: event,
              })),
              type: "turn.aborted",
              payload: { reason: asString(data.reason) ?? "Interrupted." },
            });
          }
          break;
        }
        case "session.text.started":
        case "session.reasoning.started": {
          const streamKind = event.type.startsWith("session.reasoning")
            ? "reasoning_text"
            : "assistant_text";
          const itemId = openCodeV2ContentItemId(data, streamKind);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt,
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: streamKind === "reasoning_text" ? "reasoning" : "assistant_message",
              status: "inProgress",
            },
          });
          break;
        }
        case "session.text.delta":
        case "session.reasoning.delta": {
          const streamKind = event.type.startsWith("session.reasoning")
            ? "reasoning_text"
            : "assistant_text";
          const itemId = openCodeV2ContentItemId(data, streamKind);
          const delta = asString(data.delta) ?? "";
          if (delta.length === 0) break;
          context.emittedTextByItemId.set(
            itemId,
            `${context.emittedTextByItemId.get(itemId) ?? ""}${delta}`,
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta,
            },
          });
          break;
        }
        case "session.text.ended":
        case "session.reasoning.ended": {
          const streamKind = event.type.startsWith("session.reasoning")
            ? "reasoning_text"
            : "assistant_text";
          const itemId = openCodeV2ContentItemId(data, streamKind);
          const fullText = asString(data.text) ?? "";
          const previous = context.emittedTextByItemId.get(itemId) ?? "";
          if (fullText.length > previous.length) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                createdAt,
                raw: event,
              })),
              type: "content.delta",
              payload: {
                streamKind,
                delta: fullText.slice(previous.length),
              },
            });
          }
          const completedText = fullText || previous;
          context.emittedTextByItemId.set(itemId, completedText);
          if (event.type === "session.text.ended" || completedText.trim().length > 0) {
            const reasoning = event.type === "session.reasoning.ended";
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                createdAt,
                raw: event,
              })),
              type: "item.completed",
              payload: {
                itemType: reasoning ? "reasoning" : "assistant_message",
                status: "completed",
                ...(reasoning ? { title: "Thinking" } : {}),
                ...(completedText ? { detail: completedText } : {}),
              },
            });
          }
          break;
        }
        case "session.tool.input.started": {
          const toolId = openCodeV2ToolCallId(data);
          const name = asString(data.name) ?? "tool";
          if (!toolId) break;
          context.toolNameById.set(toolId, name);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: toolId,
              createdAt,
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: toToolLifecycleItemType(name),
              status: "inProgress",
              title: name,
              data: { tool: name },
            },
          });
          break;
        }
        case "session.tool.called":
        case "session.tool.progress":
        case "session.tool.success":
        case "session.tool.failed": {
          const toolId = openCodeV2ToolCallId(data);
          if (!toolId) break;
          const terminal =
            event.type === "session.tool.success" || event.type === "session.tool.failed";
          const eventInput = data.input;
          if (eventInput !== undefined) {
            context.toolInputById.set(toolId, eventInput);
          }
          const recovered =
            terminal && context.toolInputById.get(toolId) === undefined
              ? yield* Effect.tryPromise(() =>
                  recoverProjectedTool(context.client, context.openCodeSessionId, toolId),
                ).pipe(Effect.orElseSucceed(() => undefined))
              : undefined;
          if (recovered?.input !== undefined) {
            context.toolInputById.set(toolId, recovered.input);
          }
          const knownName = context.toolNameById.get(toolId);
          const name = knownName ?? recovered?.name ?? asString(data.name) ?? "tool";
          if (terminal && knownName === undefined) {
            context.toolNameById.set(toolId, name);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: toolId,
                createdAt,
                raw: event,
              })),
              type: "item.started",
              payload: {
                itemType: toToolLifecycleItemType(name),
                status: "inProgress",
                title: name,
                data: { tool: name },
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: toolId,
              createdAt,
              raw: event,
            })),
            type: terminal ? "item.completed" : "item.updated",
            payload: {
              itemType: toToolLifecycleItemType(name),
              status:
                event.type === "session.tool.failed"
                  ? "failed"
                  : event.type === "session.tool.success"
                    ? "completed"
                    : "inProgress",
              title: name,
              data: {
                tool: name,
                ...(context.toolInputById.get(toolId) === undefined
                  ? {}
                  : { input: context.toolInputById.get(toolId) }),
                ...data,
              },
            },
          });
          break;
        }
        case "permission.asked": {
          const permission = yield* decodeOpenCodeV2Permission(data).pipe(
            Effect.mapError(invalidEventPayload(context, event)),
          );
          yield* emitPermissionOpened(context, permission, event);
          break;
        }
        case "permission.replied": {
          const { requestID, reply } = yield* decodeOpenCodeV2PermissionReply(data).pipe(
            Effect.mapError(invalidEventPayload(context, event)),
          );
          if (context.resolvedRequestIds.has(requestID)) break;
          context.resolvedRequestIds.add(requestID);
          const existing = context.pendingPermissions.get(requestID);
          context.pendingPermissions.delete(requestID);
          context.seenRequestIds.add(requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: requestID,
              createdAt,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: mapOpenCodeV2PermissionToRequestType(existing?.action),
              decision:
                reply === "always" ? "acceptForSession" : reply === "once" ? "accept" : "decline",
            },
          });
          break;
        }
        case "form.created": {
          const form = yield* decodeOpenCodeV2Form(asRecord(data.form) ?? data).pipe(
            Effect.mapError(invalidEventPayload(context, event)),
          );
          yield* emitFormRequested(context, form, event);
          break;
        }
        case "form.replied": {
          const { id, answer } = yield* decodeOpenCodeV2FormReply(data).pipe(
            Effect.mapError(invalidEventPayload(context, event)),
          );
          yield* emitFormResolved(context, id, answer, event);
          break;
        }
        case "form.cancelled": {
          const { id } = yield* decodeOpenCodeV2FormCancelled(data).pipe(
            Effect.mapError(invalidEventPayload(context, event)),
          );
          yield* emitFormResolved(context, id, {}, event);
          break;
        }
        default:
          break;
      }
    });

    const hydratePending = Effect.fn("hydrateOpenCodeV2Pending")(function* (
      context: OpenCodeV2SessionContext,
    ) {
      const [forms, permissions] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => context.client.form.list(context.openCodeSessionId),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "form.list",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }).pipe(Effect.orElseSucceed(() => [])),
          Effect.tryPromise({
            try: () => context.client.permission.list(context.openCodeSessionId),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "permission.list",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }).pipe(Effect.orElseSucceed(() => [])),
        ],
        { concurrency: "unbounded" },
      );
      for (const form of forms) {
        const mapped = yield* decodeOpenCodeV2Form(form).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: "Invalid form.list payload.",
                cause,
              }),
          ),
        );
        yield* emitFormRequested(context, mapped);
      }
      for (const permission of permissions) {
        const mapped = yield* decodeOpenCodeV2Permission(permission).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: "Invalid permission.list payload.",
                cause,
              }),
          ),
        );
        yield* emitPermissionOpened(context, mapped);
      }
    });

    const startEventPump = (
      context: OpenCodeV2SessionContext,
      iterator: AsyncIterator<OpenCodeV2Event>,
    ) =>
      Effect.gen(function* () {
        const remainingEvents: AsyncIterable<OpenCodeV2Event> = {
          [Symbol.asyncIterator]: () => iterator,
        };
        yield* Stream.fromAsyncIterable(
          remainingEvents,
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.session.threadId,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        ).pipe(
          Stream.runForEach((event) => handleEvent(context, event)),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) return;
              sessions.delete(context.session.threadId);
              if (Exit.isFailure(exit)) {
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: context.session.threadId,
                    turnId: context.activeTurnId,
                  })),
                  type: "runtime.error",
                  payload: {
                    message: "opencode2 event stream disconnected.",
                    class: "transport_error",
                  },
                });
              }
              yield* Scope.close(context.sessionScope, exit).pipe(Effect.ignore);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
        yield* hydratePending(context);
      });

    const startSession: ProviderAdapterShape<OpenCodeV2AdapterError>["startSession"] = Effect.fn(
      "startSession",
    )(function* (input) {
      const directory = input.cwd ?? serverConfig.cwd;
      const resume = parseResumeCursor(input.resumeCursor);
      if (asRecord(input.resumeCursor)?.kind === OPENCODE_V2_RESUME_KIND && !resume) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "OpenCode v2 resume cursor is invalid.",
        });
      }
      const existing = sessions.get(input.threadId);
      if (
        existing?.canRegisterMcpServers === true &&
        existing.directory === directory &&
        resume?.sessionId === existing.openCodeSessionId
      ) {
        yield* Effect.forEach(
          McpProviderSession.readMcpProviderSessions(input.threadId),
          (mcpSession) =>
            Effect.tryPromise({
              try: () =>
                existing.client.mcp.add(McpProviderSession.getMcpProviderSessionName(mcpSession), {
                  type: "remote",
                  url: mcpSession.endpoint,
                  headers: { Authorization: mcpSession.authorizationHeader },
                  oauth: false,
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "mcp.add",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            }),
          { discard: true },
        );
        const updatedAt = yield* nowIso;
        existing.session = {
          ...existing.session,
          providerThreadId: existing.openCodeSessionId,
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          updatedAt,
        };
        yield* hydratePending(existing);
        return existing.session;
      }
      if (existing) {
        yield* Scope.close(existing.sessionScope, Exit.void).pipe(Effect.ignore);
        sessions.delete(input.threadId);
      }

      const sessionScope = yield* Scope.make();
      const startedExit = yield* Effect.exit(
        Effect.gen(function* () {
          const server = yield* openCodeRuntime.connectToOpenCodeServer({
            binaryPath: settings.binaryPath,
            requiredProtocol: "v2",
            serverUrl: settings.serverUrl,
            ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
            ...(options?.environment ? { environment: options.environment } : {}),
          });
          const client = createClient({
            baseUrl: server.url,
            directory,
            ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
          });
          const mcpSessions = McpProviderSession.readMcpProviderSessions(input.threadId);
          if (!server.external) {
            yield* Effect.forEach(
              mcpSessions,
              (mcpSession) =>
                Effect.tryPromise({
                  try: () =>
                    client.mcp.add(McpProviderSession.getMcpProviderSessionName(mcpSession), {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: { Authorization: mcpSession.authorizationHeader },
                      oauth: false,
                    }),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "mcp.add",
                      detail: cause instanceof Error ? cause.message : String(cause),
                      cause,
                    }),
                }),
              { discard: true },
            );
          }
          const controller = new AbortController();
          yield* Scope.addFinalizer(
            sessionScope,
            Effect.sync(() => controller.abort()),
          );
          const subscription = client.event.subscribe({ signal: controller.signal });
          const iterator = subscription[Symbol.asyncIterator]();
          const first = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
          if (first.done || first.value.type !== "server.connected") {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "OpenCode v2 event stream did not start with server.connected.",
            });
          }
          const adopted = resume?.sessionId
            ? yield* Effect.tryPromise({
                try: () => client.session.get(resume.sessionId),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.get",
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              }).pipe(Effect.option)
            : undefined;
          const projectedToolsById =
            adopted?._tag === "Some"
              ? yield* Effect.tryPromise(() =>
                  recoverAllProjectedTools(client, adopted.value.id),
                ).pipe(Effect.orElseSucceed(() => new Map<string, OpenCodeV2ProjectedTool>()))
              : new Map<string, OpenCodeV2ProjectedTool>();
          const toolNameById = new Map(
            [...projectedToolsById].map(([id, tool]) => [id, tool.name] as const),
          );
          const toolInputById = new Map(
            [...projectedToolsById].flatMap(([id, tool]) =>
              tool.input === undefined ? [] : ([[id, tool.input]] as const),
            ),
          );
          const sessionInfo: OpenCodeV2SessionInfo =
            adopted && adopted._tag === "Some"
              ? adopted.value
              : yield* Effect.tryPromise({
                  try: () =>
                    client.session.create({
                      location: { directory },
                    }),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session.create",
                      detail: cause instanceof Error ? cause.message : String(cause),
                      cause,
                    }),
                });
          return {
            client,
            iterator,
            sessionInfo,
            serverExternal: server.external,
            toolNameById,
            toolInputById,
            adopted: adopted?._tag === "Some",
          };
        }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
      );
      if (Exit.isFailure(startedExit)) {
        yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Failed to start OpenCode v2 session.",
          cause: startedExit.cause,
        });
      }

      const createdAt = yield* nowIso;
      const resumedTurnId =
        startedExit.value.adopted && resume?.activeTurnId
          ? TurnId.make(resume.activeTurnId)
          : undefined;
      const remoteBusy =
        resumedTurnId === undefined
          ? false
          : yield* Effect.tryPromise(() => startedExit.value.client.session.active()).pipe(
              Effect.map((activeSessions) => {
                const type = activeSessions[startedExit.value.sessionInfo.id]?.type;
                return type === "running";
              }),
              Effect.orElseSucceed(() => undefined),
            );
      const adoptedTurnId =
        resumedTurnId !== undefined && remoteBusy !== false ? resumedTurnId : undefined;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        providerThreadId: startedExit.value.sessionInfo.id,
        status: adoptedTurnId ? "running" : "ready",
        runtimeMode: input.runtimeMode,
        cwd: directory,
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        resumeCursor: makeResumeCursor({
          sessionId: startedExit.value.sessionInfo.id,
          ...(adoptedTurnId ? { activeTurnId: String(adoptedTurnId) } : {}),
        }),
        ...(adoptedTurnId ? { activeTurnId: adoptedTurnId } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      const context: OpenCodeV2SessionContext = {
        session,
        client: startedExit.value.client,
        directory,
        canRegisterMcpServers: !startedExit.value.serverExternal,
        openCodeSessionId: startedExit.value.sessionInfo.id,
        pendingPermissions: new Map(),
        pendingForms: new Map(),
        seenRequestIds: new Set(),
        resolvedRequestIds: new Set(),
        toolNameById: startedExit.value.toolNameById,
        toolInputById: startedExit.value.toolInputById,
        emittedTextByItemId: new Map(),
        activeTurnId: adoptedTurnId,
        missingTerminalRecoveryAttempts: 0,
        stopped: yield* Ref.make(false),
        sessionScope,
      };
      sessions.set(input.threadId, context);
      const pumpExit = yield* Effect.exit(startEventPump(context, startedExit.value.iterator));
      if (Exit.isFailure(pumpExit)) {
        sessions.delete(input.threadId);
        yield* Scope.close(sessionScope, pumpExit).pipe(Effect.ignore);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Failed to subscribe to the OpenCode v2 event stream.",
          cause: pumpExit.cause,
        });
      }
      if (resumedTurnId !== undefined) {
        if (adoptedTurnId !== undefined) {
          yield* Effect.tryPromise(() =>
            context.client.session.wait(context.openCodeSessionId),
          ).pipe(
            Effect.flatMap(() =>
              Effect.gen(function* () {
                if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== adoptedTurnId) {
                  return;
                }
                context.activeTurnId = undefined;
                const { activeTurnId: _activeTurnId, ...settledSession } = context.session;
                context.session = { ...settledSession, status: "ready" };
                writeResume(context, true);
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId: adoptedTurnId,
                  })),
                  type: "turn.completed",
                  payload: { state: "completed" },
                });
              }),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("OpenCode v2 resumed turn reconciler failed", {
                threadId: input.threadId,
                sessionId: context.openCodeSessionId,
                turnId: adoptedTurnId,
                cause,
              }),
            ),
            Effect.forkIn(context.sessionScope),
          );
        } else {
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId: resumedTurnId })),
            type: "turn.completed",
            payload: { state: "completed" },
          });
        }
      }
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "session.started",
        payload: { message: "opencode2 session started" },
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "thread.started",
        payload: { providerThreadId: context.openCodeSessionId },
      });
      return context.session;
    });

    const sendTurn: ProviderAdapterShape<OpenCodeV2AdapterError>["sendTurn"] = Effect.fn(
      "sendTurn",
    )(function* (input) {
      const context = yield* ensureSession(input.threadId);
      const existingTurnId = context.activeTurnId;
      const turnId = existingTurnId ?? TurnId.make(`opencode2-turn-${yield* randomUUIDv4}`);
      if (existingTurnId === undefined) context.missingTerminalRecoveryAttempts = 0;
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode v2 model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode v2 model selection must use the 'provider/model' format.",
        });
      }
      const text = input.input?.trim();
      const files = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      }).map((file) => ({
        uri: file.url,
        ...(file.filename === undefined ? {} : { name: file.filename }),
      }));
      if (!text && files.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode v2 turns require text input or at least one attachment.",
        });
      }
      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
      yield* Effect.tryPromise({
        try: async () => {
          if (agent) {
            await context.client.session.switchAgent(context.openCodeSessionId, agent);
          }
          await context.client.session.switchModel(context.openCodeSessionId, {
            providerID: parsedModel.providerID,
            id: parsedModel.modelID,
            ...(variant ? { variant } : {}),
          });
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.switchModel",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        model: modelSelection?.model ?? context.session.model,
      };
      writeResume(context);
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: { model: context.session.model },
      });
      yield* Effect.tryPromise({
        try: () =>
          context.client.session.prompt(context.openCodeSessionId, {
            text: text ?? "",
            ...(files.length > 0 ? { files } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
      };
    });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        hasDurableSessionRecovery: (resumeCursor) =>
          Effect.succeed(parseResumeCursor(resumeCursor) !== undefined),
      },
      startSession,
      sendTurn,
      interruptTurn: Effect.fn("interruptTurn")(function* (threadId, turnId) {
        const context = yield* ensureSession(threadId);
        const interruptedTurnId = turnId ?? context.activeTurnId;
        const pendingFormIds = [...context.pendingForms.keys()];
        yield* Effect.forEach(
          pendingFormIds,
          (formId) =>
            Effect.tryPromise(() =>
              context.client.form.cancel(context.openCodeSessionId, formId),
            ).pipe(Effect.ignore),
          { concurrency: "unbounded" },
        );
        yield* Effect.tryPromise({
          try: () => context.client.session.interrupt(context.openCodeSessionId),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.interrupt",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        context.activeTurnId = undefined;
        const { activeTurnId: _, ...settledSession } = context.session;
        context.session = { ...settledSession, status: "ready" };
        writeResume(context, true);
        yield* Effect.forEach(pendingFormIds, (formId) => emitFormResolved(context, formId, {}));
        if (interruptedTurnId) {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId: interruptedTurnId })),
            type: "turn.aborted",
            payload: { reason: "Interrupted by user." },
          });
        }
      }),
      respondToRequest: Effect.fn("respondToRequest")(function* (threadId, requestId, decision) {
        const context = yield* ensureSession(threadId);
        const permission = context.pendingPermissions.get(requestId);
        if (!permission) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }
        yield* Effect.tryPromise({
          try: () =>
            context.client.permission.reply(
              context.openCodeSessionId,
              requestId,
              toPermissionReply(decision),
            ),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission.reply",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        if (context.resolvedRequestIds.has(requestId)) return;
        context.pendingPermissions.delete(requestId);
        context.seenRequestIds.add(requestId);
        context.resolvedRequestIds.add(requestId);
        yield* emit({
          ...(yield* buildEventBase({
            threadId,
            turnId: context.activeTurnId,
            requestId,
          })),
          type: "request.resolved",
          payload: {
            requestType: mapOpenCodeV2PermissionToRequestType(permission.action),
            decision,
          },
        });
      }),
      respondToUserInput: Effect.fn("respondToUserInput")(function* (threadId, requestId, answers) {
        const context = yield* ensureSession(threadId);
        const form = context.pendingForms.get(requestId);
        if (!form) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "form.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Effect.tryPromise({
          try: () =>
            context.client.form.reply(
              context.openCodeSessionId,
              requestId,
              toOpenCodeV2FormAnswer(form, answers),
            ),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "form.reply",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        yield* emitFormResolved(context, requestId, answers);
      }),
      stopSession: Effect.fn("stopSession")(function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        yield* Ref.set(context.stopped, true);
        sessions.delete(threadId);
        yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
        });
      }),
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: () =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "readThread",
          detail: "OpenCode v2 thread snapshots are not implemented yet.",
        }),
      rollbackThread: () =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "OpenCode v2 rollback is not implemented yet.",
        }),
      stopAll: () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) =>
              Ref.set(context.stopped, true).pipe(
                Effect.andThen(Scope.close(context.sessionScope, Exit.void)),
                Effect.ignore,
              ),
            { concurrency: "unbounded", discard: true },
          );
        }),
      streamEvents: Stream.fromQueue(runtimeEvents),
    } satisfies ProviderAdapterShape<OpenCodeV2AdapterError>;
  });
}
