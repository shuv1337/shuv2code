import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AdeProject,
  ArtifactRef,
  Assignment,
  Bot,
  BotExecutionBinding,
  IntegrationCandidate,
  LimitsConfig,
  MemoryDocument,
  NeedsYouItem,
  PersonaVersion,
  PublicationLayer,
  PublicationStack,
  ScreenboxProvisioning,
} from "./ade.ts";

const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, encoded: unknown) => {
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  const reEncoded = Schema.encodeUnknownSync(schema)(decoded);
  assert.deepEqual(reEncoded, encoded);
  return decoded;
};

const decodeBot = Schema.decodeUnknownSync(Bot);
const decodeMemoryDocument = Schema.decodeUnknownSync(MemoryDocument);
const decodeArtifactRef = Schema.decodeUnknownSync(ArtifactRef);
const decodeAssignment = Schema.decodeUnknownSync(Assignment);
const decodeLimitsConfig = Schema.decodeUnknownSync(LimitsConfig);

it("round-trips a Bot and defaults computerUse to false", () => {
  const bot = roundTrip(Bot, {
    id: "bot-firstmate",
    name: "Firstmate",
    displayMeta: { emoji: "🧭", color: "#224466", description: "Workspace coordinator" },
    structuralRole: "firstmate",
    roleTag: "Coordinator",
    projectId: null,
    activePersonaVersionId: "persona-1",
    computerUse: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
  });
  assert.strictEqual(bot.structuralRole, "firstmate");

  const defaulted = decodeBot({
    id: "bot-crew",
    name: "Coder",
    displayMeta: null,
    structuralRole: "crew",
    roleTag: "Coder",
    projectId: "project-1",
    activePersonaVersionId: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
  });
  assert.strictEqual(defaulted.computerUse, false);

  assert.throws(() =>
    decodeBot({
      id: "bot-x",
      name: "X",
      displayMeta: null,
      structuralRole: "captain",
      roleTag: "X",
      projectId: null,
      activePersonaVersionId: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      archivedAt: null,
    }),
  );
});

it("round-trips a PersonaVersion", () => {
  roundTrip(PersonaVersion, {
    id: "persona-1",
    botId: "bot-firstmate",
    content: "You are the Firstmate.",
    createdAt: "2026-08-24T00:00:00.000Z",
    activatedAt: "2026-08-24T00:05:00.000Z",
  });
});

it("round-trips a MemoryDocument and rejects unknown authors", () => {
  roundTrip(MemoryDocument, {
    botId: "bot-firstmate",
    content: "Prefers concise updates.",
    updatedAt: "2026-08-24T00:00:00.000Z",
    updatedBy: "captain",
  });
  assert.throws(() =>
    decodeMemoryDocument({
      botId: "bot-firstmate",
      content: "x",
      updatedAt: "2026-08-24T00:00:00.000Z",
      updatedBy: "other-bot",
    }),
  );
});

it("round-trips a BotExecutionBinding", () => {
  const binding = roundTrip(BotExecutionBinding, {
    id: "binding-1",
    botId: "bot-crew",
    engine: "shuvcode",
    sessionId: "sess-abc",
    purpose: "primary-text",
    status: "active",
    rolloverSummary: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  assert.strictEqual(binding.engine, "shuvcode");
});

it("round-trips every ArtifactRef variant and rejects unknown tags", () => {
  const artifacts = [
    { _tag: "jjChange", changeId: "zkmqwpxr", projectId: "project-1" },
    { _tag: "publicationLayer", stackId: "stack-1", layerId: "layer-1" },
    { _tag: "file", path: "docs/report.md" },
    { _tag: "url", href: "https://example.com/run/1" },
  ];
  for (const artifact of artifacts) {
    roundTrip(ArtifactRef, artifact);
  }
  assert.throws(() => decodeArtifactRef({ _tag: "gitBranch", name: "main" }));
});

it("round-trips an Assignment with result and delivery record", () => {
  const assignment = roundTrip(Assignment, {
    id: "assignment-1",
    idempotencyKey: "toolcall-77",
    requester: { _tag: "bot", botId: "bot-secondmate" },
    recipientBotId: "bot-crew",
    projectId: "project-1",
    instruction: "Implement the widget",
    declaredRisk: "normal",
    parentAssignmentId: "assignment-0",
    status: "completed",
    blockedReason: null,
    queuePosition: 0,
    result: {
      status: "completed",
      summary: "Widget implemented",
      artifacts: [{ _tag: "jjChange", changeId: "zkmqwpxr", projectId: "project-1" }],
    },
    delivery: { delivered: true, deliveredAt: "2026-08-24T01:00:00.000Z" },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T01:00:00.000Z",
  });
  assert.strictEqual(assignment.requester._tag, "bot");

  roundTrip(Assignment, {
    id: "assignment-2",
    idempotencyKey: "captain-1",
    requester: { _tag: "captain" },
    recipientBotId: "bot-crew",
    projectId: null,
    instruction: "Investigate flaky boot",
    declaredRisk: "mechanical",
    parentAssignmentId: null,
    status: "blocked",
    blockedReason: "approval",
    queuePosition: 2,
    result: null,
    delivery: { delivered: false, deliveredAt: null },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
});

it("rejects an Assignment result summary over 16 KB", () => {
  assert.throws(() =>
    decodeAssignment({
      id: "assignment-3",
      idempotencyKey: "key-3",
      requester: { _tag: "captain" },
      recipientBotId: "bot-crew",
      projectId: null,
      instruction: "x",
      declaredRisk: "normal",
      parentAssignmentId: null,
      status: "completed",
      blockedReason: null,
      queuePosition: 0,
      result: { status: "completed", summary: "y".repeat(16_385), artifacts: [] },
      delivery: { delivered: false, deliveredAt: null },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    }),
  );
});

it("round-trips an AdeProject with both allow-list shapes", () => {
  roundTrip(AdeProject, {
    id: "project-1",
    name: "shuv2code",
    secondMateBotId: "bot-secondmate",
    repoBinding: { path: "/home/captain/repos/shuv2code", remote: "origin" },
    integrationPolicyDefault: "agent-review",
    checkCommands: ["vp check", "vp test run"],
    sharedSpecialistAllowList: "all",
    limitsOverrides: { maxQueuedAssignmentsPerBot: 5 },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  const scoped = roundTrip(AdeProject, {
    id: "project-2",
    name: "notes",
    secondMateBotId: "bot-secondmate-2",
    repoBinding: null,
    integrationPolicyDefault: "automatic",
    checkCommands: [],
    sharedSpecialistAllowList: ["bot-researcher"],
    limitsOverrides: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  assert.notStrictEqual(scoped.sharedSpecialistAllowList, "all");
  assert.strictEqual(scoped.sharedSpecialistAllowList[0], "bot-researcher");
});

it("round-trips an IntegrationCandidate", () => {
  roundTrip(IntegrationCandidate, {
    id: "candidate-1",
    projectId: "project-1",
    sourceAssignmentIds: ["assignment-1", "assignment-2"],
    changeIds: ["zkmqwpxr", "qwlnnmts"],
    status: "awaiting-review",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
});

it("round-trips a PublicationStack and PublicationLayer", () => {
  roundTrip(PublicationStack, {
    id: "stack-1",
    projectId: "project-1",
    mode: "native-stack",
    status: "review-frozen",
    stackUrl: "https://github.com/shuv1337/shuv2code/stacks/7",
    nativeStackNumber: 7,
    nativeStackNodeId: "ST_kwDO",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  roundTrip(PublicationLayer, {
    id: "layer-1",
    stackId: "stack-1",
    order: 0,
    changeIds: ["zkmqwpxr"],
    bookmarkName: "ade/publish/stack-1/layer-1",
    prNumber: 158,
    headSha: "a".repeat(40),
    submittedSha: "b".repeat(40),
    mergeSha: null,
    prState: "open",
    status: "submitted",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
});

it("round-trips a ScreenboxProvisioning record", () => {
  roundTrip(ScreenboxProvisioning, {
    botId: "bot-crew",
    status: "running",
    containerRef: "screenbox-bot-crew",
    volumeRef: "vol-bot-crew",
    createdAt: "2026-08-24T00:00:00.000Z",
    lastNeededAt: "2026-08-24T02:00:00.000Z",
  });
});

it("round-trips a NeedsYouItem with mixed subject refs", () => {
  roundTrip(NeedsYouItem, {
    id: "needsyou-1",
    kind: "kernel-down",
    subjectRefs: [
      { _tag: "kernel", engine: "codex" },
      { _tag: "assignment", assignmentId: "assignment-1" },
    ],
    status: "open",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    resolvedAt: null,
  });
});

it("decodes LimitsConfig defaults from an empty object (ADR §18.1 seed)", () => {
  const limits = decodeLimitsConfig({});
  assert.deepEqual(limits, {
    maxBots: 24,
    maxConcurrentAssignments: 16,
    maxParallelSessionsPerBot: 3,
    maxDelegationDepth: 5,
    maxQueuedAssignmentsPerBot: 20,
    maxResultSummaryLength: 16_384,
    maxConcurrentScreenboxDesktops: 4,
    screenboxIdleStopMinutes: 30,
  });
});

it("round-trips an explicit LimitsConfig", () => {
  roundTrip(LimitsConfig, {
    maxBots: 10,
    maxConcurrentAssignments: 4,
    maxParallelSessionsPerBot: 1,
    maxDelegationDepth: 2,
    maxQueuedAssignmentsPerBot: 3,
    maxResultSummaryLength: 1_024,
    maxConcurrentScreenboxDesktops: 1,
    screenboxIdleStopMinutes: 5,
  });
});
