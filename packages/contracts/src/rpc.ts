import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AdeAssignmentGraph,
  AdeAssignmentGraphInput,
  AdeBotChatSession,
  AdeBotDetail,
  AdeBotIdInput,
  AdeBotRoutineContext,
  AdeBotGroup,
  AdeBotScreen,
  AdeCaptainError,
  AdeCreateBotFromTemplateInput,
  AdeCreateProjectInput,
  AdeCreatedProject,
  AdeDeleteBotGroupInput,
  AdeDeletedBot,
  AdeDeletedBotGroup,
  AdeEditPersonaInput,
  AdeListNeedsYouInput,
  AdeNeedsYouCount,
  AdeNeedsYouEntry,
  AdeNeedsYouItemIdInput,
  AdeNeedsYouList,
  AdeProjectCandidates,
  AdeProjectDetail,
  AdeProjectIdInput,
  AdePublicationStackIdInput,
  AdePublicationStackView,
  AdeBotChatReadReceipt,
  AdeMarkBotChatReadInput,
  AdeRoster,
  AdeSubmitNeedsYouDecisionInput,
  AdeSetComputerUseInput,
  AdeUpdateBotIdentityInput,
  AdeUpsertBotGroupInput,
  AdeWriteMemoryInput,
  Bot,
  FleetHealthSnapshot,
  MemoryDocument,
  PersonaVersion,
} from "./ade.ts";
import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  AutomationCreateInput,
  AutomationDeleteInput,
  AutomationDeleteResult,
  AutomationError,
  AutomationGetInput,
  AutomationListInput,
  AutomationListResult,
  AutomationListRunsInput,
  AutomationListRunsResult,
  AutomationRun,
  AutomationRunNowInput,
  AutomationUpdateInput,
  AutomationValidateScheduleInput,
  AutomationValidationResult,
  ProjectAutomation,
} from "./automations.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  VcsFetchInput,
  VcsFetchResult,
  VcsDescribeChangeInput,
  VcsDescribeChangeResult,
  VcsStartChangeInput,
  VcsStartChangeResult,
  VcsPushBookmarkInput,
  VcsPushBookmarkResult,
  VcsCreateChangeRequestInput,
  VcsCreateChangeRequestResult,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
  OrchestrationGetWorkflowScriptError,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestInvalidateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import { UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError, VcsSetProjectPreferenceInput, VcsSetProjectPreferenceResult } from "./vcs.ts";
import {
  VoiceControllerError,
  VoiceEnsureControllerInput,
  VoiceEnsureControllerResult,
  VoiceGetActiveCallInput,
  VoiceGetActiveCallResult,
  VoiceGetControllerInput,
  VoiceGetControllerResult,
  VoiceGetControllerHistoryInput,
  VoiceGetControllerHistoryResult,
  VoiceListVoicesInput,
  VoiceAppendAudioInput,
  VoiceAppendAudioResult,
  VoiceListVoicesResult,
  VoicePrepareThreadCallInput,
  VoicePrepareThreadCallResult,
  VoiceRealtimeIngressInput,
  VoiceRealtimeIngressResult,
  VoiceResetControllerInput,
  VoiceResetControllerResult,
  VoiceSetControllerTargetInput,
  VoiceSetControllerTargetResult,
  VoiceSessionEvent,
  VoiceSessionStartInput,
  VoiceSessionStartResult,
  VoiceSessionStopInput,
  VoiceSessionStopResult,
  VoiceSubscribeEventsInput,
} from "./realtimeVoice.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Project automation methods
  automationsList: "automations.list",
  automationsGet: "automations.get",
  automationsCreate: "automations.create",
  automationsUpdate: "automations.update",
  automationsDelete: "automations.delete",
  automationsRunNow: "automations.runNow",
  automationsListRuns: "automations.listRuns",
  automationsValidateSchedule: "automations.validateSchedule",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsFetch: "vcs.fetch",
  vcsDescribeChange: "vcs.describeChange",
  vcsStartChange: "vcs.startChange",
  vcsPushBookmark: "vcs.pushBookmark",
  vcsCreateChangeRequest: "vcs.createChangeRequest",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",
  vcsSetProjectPreference: "vcs.setProjectPreference",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  serverGetUsageSummary: "server.getUsageSummary",

  // Realtime voice controller
  voiceGetController: "voice.getController",
  voiceGetActiveCall: "voice.getActiveCall",
  voiceGetControllerHistory: "voice.getControllerHistory",
  voiceSetControllerTarget: "voice.setControllerTarget",
  voiceEnsureController: "voice.ensureController",
  voiceListVoices: "voice.listVoices",
  voicePrepareThreadCall: "voice.prepareThreadCall",
  voiceResetController: "voice.resetController",
  voiceStart: "voice.start",
  voiceIngestRealtimeEvent: "voice.ingestRealtimeEvent",
  voiceAppendAudio: "voice.appendAudio",
  voiceStop: "voice.stop",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // ADE captain-surface methods (spec §7 slices 1, 2, 8)
  adeGetRoster: "ade.getRoster",
  adeGetBot: "ade.getBot",
  adeGetProject: "ade.getProject",
  adeListProjectCandidates: "ade.listProjectCandidates",
  adeGetProjectPublicationStack: "ade.getProjectPublicationStack",
  adeGetPublicationStack: "ade.getPublicationStack",
  adeGetAssignmentGraph: "ade.getAssignmentGraph",
  adeCreateBotFromTemplate: "ade.createBotFromTemplate",
  adeCreateProject: "ade.createProject",
  adeWriteBotMemory: "ade.writeBotMemory",
  adeEditBotPersona: "ade.editBotPersona",
  adeSetBotComputerUse: "ade.setBotComputerUse",
  adeUpdateBotIdentity: "ade.updateBotIdentity",
  adeUpsertBotGroup: "ade.upsertBotGroup",
  adeDeleteBotGroup: "ade.deleteBotGroup",
  adeGetNeedsYouCount: "ade.getNeedsYouCount",
  adeListNeedsYou: "ade.listNeedsYou",
  adeGetNeedsYouItem: "ade.getNeedsYouItem",
  adeSubmitNeedsYouDecision: "ade.submitNeedsYouDecision",
  adeStartBotChat: "ade.startBotChat",
  adeGetBotScreen: "ade.getBotScreen",
  adeGetBotRoutineContext: "ade.getBotRoutineContext",
  adeStartBotDesktop: "ade.startBotDesktop",
  adeStopBotDesktop: "ade.stopBotDesktop",
  adeDeleteBot: "ade.deleteBot",
  adeMarkBotChatRead: "ade.markBotChatRead",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
  subscribeVoiceEvents: "subscribeVoiceEvents",
  subscribeAdeFleetHealth: "subscribeAdeFleetHealth",
  subscribeAdeRoster: "subscribeAdeRoster",
} as const;

export const WsAutomationsListRpc = Rpc.make(WS_METHODS.automationsList, {
  payload: AutomationListInput,
  success: AutomationListResult,
  error: Schema.Union([AutomationError, EnvironmentAuthorizationError]),
});

export const WsAutomationsGetRpc = Rpc.make(WS_METHODS.automationsGet, {
  payload: AutomationGetInput,
  success: ProjectAutomation,
  error: Schema.Union([AutomationError, EnvironmentAuthorizationError]),
});

export const WsAutomationsCreateRpc = Rpc.make(WS_METHODS.automationsCreate, {
  payload: AutomationCreateInput,
  success: ProjectAutomation,
  error: Schema.Union([AutomationError, EnvironmentAuthorizationError]),
});

export const WsAutomationsUpdateRpc = Rpc.make(WS_METHODS.automationsUpdate, {
  payload: AutomationUpdateInput,
  success: ProjectAutomation,
  error: Schema.Union([AutomationError, EnvironmentAuthorizationError]),
});

export const WsAutomationsDeleteRpc = Rpc.make(WS_METHODS.automationsDelete, {
  payload: AutomationDeleteInput,
  success: AutomationDeleteResult,
  error: Schema.Union([AutomationError, EnvironmentAuthorizationError]),
});

export const WsAutomationsRunNowRpc = Rpc.make(WS_METHODS.automationsRunNow, {
  payload: AutomationRunNowInput,
  success: AutomationRun,
  error: Schema.Union([AutomationError, EnvironmentAuthorizationError]),
});

export const WsAutomationsListRunsRpc = Rpc.make(WS_METHODS.automationsListRuns, {
  payload: AutomationListRunsInput,
  success: AutomationListRunsResult,
  error: Schema.Union([AutomationError, EnvironmentAuthorizationError]),
});

export const WsAutomationsValidateScheduleRpc = Rpc.make(WS_METHODS.automationsValidateSchedule, {
  payload: AutomationValidateScheduleInput,
  success: AutomationValidationResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerWithProgressRpc = Rpc.make(
  WS_METHODS.serverUpdateServerWithProgress,
  {
    payload: ServerSelfUpdateInput,
    success: ServerSelfUpdateProgressEvent,
    error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

export const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsVoiceEnsureControllerRpc = Rpc.make(WS_METHODS.voiceEnsureController, {
  payload: VoiceEnsureControllerInput,
  success: VoiceEnsureControllerResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceGetControllerRpc = Rpc.make(WS_METHODS.voiceGetController, {
  payload: VoiceGetControllerInput,
  success: VoiceGetControllerResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceGetActiveCallRpc = Rpc.make(WS_METHODS.voiceGetActiveCall, {
  payload: VoiceGetActiveCallInput,
  success: VoiceGetActiveCallResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceGetControllerHistoryRpc = Rpc.make(WS_METHODS.voiceGetControllerHistory, {
  payload: VoiceGetControllerHistoryInput,
  success: VoiceGetControllerHistoryResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceSetControllerTargetRpc = Rpc.make(WS_METHODS.voiceSetControllerTarget, {
  payload: VoiceSetControllerTargetInput,
  success: VoiceSetControllerTargetResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceListVoicesRpc = Rpc.make(WS_METHODS.voiceListVoices, {
  payload: VoiceListVoicesInput,
  success: VoiceListVoicesResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoicePrepareThreadCallRpc = Rpc.make(WS_METHODS.voicePrepareThreadCall, {
  payload: VoicePrepareThreadCallInput,
  success: VoicePrepareThreadCallResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceResetControllerRpc = Rpc.make(WS_METHODS.voiceResetController, {
  payload: VoiceResetControllerInput,
  success: VoiceResetControllerResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceStartRpc = Rpc.make(WS_METHODS.voiceStart, {
  payload: VoiceSessionStartInput,
  success: VoiceSessionStartResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceIngestRealtimeEventRpc = Rpc.make(WS_METHODS.voiceIngestRealtimeEvent, {
  payload: VoiceRealtimeIngressInput,
  success: VoiceRealtimeIngressResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceAppendAudioRpc = Rpc.make(WS_METHODS.voiceAppendAudio, {
  payload: VoiceAppendAudioInput,
  success: VoiceAppendAudioResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsVoiceStopRpc = Rpc.make(WS_METHODS.voiceStop, {
  payload: VoiceSessionStopInput,
  success: VoiceSessionStopResult,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
});

export const WsSubscribeVoiceEventsRpc = Rpc.make(WS_METHODS.subscribeVoiceEvents, {
  payload: VoiceSubscribeEventsInput,
  success: VoiceSessionEvent,
  error: Schema.Union([VoiceControllerError, EnvironmentAuthorizationError]),
  stream: true,
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

export const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

/**
 * The line counts for rows already on the page. Its own call because on GitHub the pair costs
 * 40-60% of the listing read that answers everything else on the row, so the rows arrive first
 * and their stats a moment later.
 */
export const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

export const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

export const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSetThreadResolutionRpc = Rpc.make(
  WS_METHODS.pullRequestsSetThreadResolution,
  {
    payload: PullRequestThreadResolutionInput,
    success: Schema.Void,
    error: PullRequestRpcError,
  },
);

export const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

/**
 * Read on its own rather than as part of the detail: the people who may be asked are only wanted
 * once somebody opens the menu, and reading them with every change request would spend a request
 * per host on a list nobody looked at.
 */
export const WsPullRequestsReviewerCandidatesRpc = Rpc.make(
  WS_METHODS.pullRequestsReviewerCandidates,
  {
    payload: PullRequestRef,
    success: PullRequestReviewerCandidateList,
    error: PullRequestRpcError,
  },
);

export const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsFetchRpc = Rpc.make(WS_METHODS.vcsFetch, {
  payload: VcsFetchInput,
  success: VcsFetchResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsDescribeChangeRpc = Rpc.make(WS_METHODS.vcsDescribeChange, {
  payload: VcsDescribeChangeInput,
  success: VcsDescribeChangeResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsStartChangeRpc = Rpc.make(WS_METHODS.vcsStartChange, {
  payload: VcsStartChangeInput,
  success: VcsStartChangeResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsPushBookmarkRpc = Rpc.make(WS_METHODS.vcsPushBookmark, {
  payload: VcsPushBookmarkInput,
  success: VcsPushBookmarkResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateChangeRequestRpc = Rpc.make(WS_METHODS.vcsCreateChangeRequest, {
  payload: VcsCreateChangeRequestInput,
  success: VcsCreateChangeRequestResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

export const WsVcsSetProjectPreferenceRpc = Rpc.make(WS_METHODS.vcsSetProjectPreference, {
  payload: VcsSetProjectPreferenceInput,
  success: VcsSetProjectPreferenceResult,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted shuv2code Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({
      configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
    }),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationRpcSchemas.getWorkflowScript.input,
    success: OrchestrationRpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * ADE fleet health (spec §4.8): latest `FleetHealthSnapshot` on subscribe,
 * then one snapshot per state change — the sidebar kernel pill feed.
 */
export const WsSubscribeAdeFleetHealthRpc = Rpc.make(WS_METHODS.subscribeAdeFleetHealth, {
  payload: Schema.Struct({}),
  success: FleetHealthSnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * The live contact rail (`docs/ade/MESSENGER-PIVOT.md` §4, M3): the current
 * `AdeRoster` on subscribe, then one frame per *observable* change.
 *
 * Modelled on `subscribeAdeFleetHealth` rather than left as `ade.getRoster` on
 * a timer because previews, unread counts and attention lines are the fields a
 * poll interval is most visibly wrong about — a 15s poll makes a messenger
 * that looks broken. Frames are debounced and change-gated server-side, so an
 * idle fleet costs one subscription and no traffic.
 */
export const WsSubscribeAdeRosterRpc = Rpc.make(WS_METHODS.subscribeAdeRoster, {
  payload: Schema.Struct({}),
  success: AdeRoster,
  // Carries `AdeCaptainError` as well as the authorization failure, unlike the
  // other subscriptions: this one is backed by a database read that can fail on
  // subscribe, and the alternative to reporting that is handing the rail an
  // empty roster — which renders as "you have no bots" and offers to create the
  // first project. A read failure and an empty fleet must not look alike.
  error: Schema.Union([AdeCaptainError, EnvironmentAuthorizationError]),
  stream: true,
});

// ---------------------------------------------------------------------------
// ADE captain surface (spec §7 slices 1, 2, 8)
// ---------------------------------------------------------------------------

const AdeCaptainRpcError = Schema.Union([AdeCaptainError, EnvironmentAuthorizationError]);

/** Roster list (slice 2): every bot, Firstmate pinned first, plus templates. */
export const WsAdeGetRosterRpc = Rpc.make(WS_METHODS.adeGetRoster, {
  payload: Schema.Struct({}),
  success: AdeRoster,
  error: AdeCaptainRpcError,
});

/**
 * Clear a bot's unread count (§4, M3). Fired when the captain is demonstrably
 * looking at the bottom of that conversation, never merely on navigation.
 */
export const WsAdeMarkBotChatReadRpc = Rpc.make(WS_METHODS.adeMarkBotChatRead, {
  payload: AdeMarkBotChatReadInput,
  success: AdeBotChatReadReceipt,
  error: AdeCaptainRpcError,
});

export const WsAdeGetBotRpc = Rpc.make(WS_METHODS.adeGetBot, {
  payload: AdeBotIdInput,
  success: AdeBotDetail,
  error: AdeCaptainRpcError,
});

/** Copy-on-create crew instantiation (spec §4.1). */
export const WsAdeCreateBotFromTemplateRpc = Rpc.make(WS_METHODS.adeCreateBotFromTemplate, {
  payload: AdeCreateBotFromTemplateInput,
  success: AdeBotDetail,
  error: AdeCaptainRpcError,
});

/** Captain-authored memory write (ADR §12.2 — author is always `captain`). */
export const WsAdeWriteBotMemoryRpc = Rpc.make(WS_METHODS.adeWriteBotMemory, {
  payload: AdeWriteMemoryInput,
  success: MemoryDocument,
  error: AdeCaptainRpcError,
});

/** Persona edit; takes effect at the bot's next session (ADR §12.1). */
export const WsAdeEditBotPersonaRpc = Rpc.make(WS_METHODS.adeEditBotPersona, {
  payload: AdeEditPersonaInput,
  success: PersonaVersion,
  error: AdeCaptainRpcError,
});

export const WsAdeSetBotComputerUseRpc = Rpc.make(WS_METHODS.adeSetBotComputerUse, {
  payload: AdeSetComputerUseInput,
  success: Bot,
  error: AdeCaptainRpcError,
});

/**
 * The captain's editable label for a bot (messenger pivot §4, #197): name,
 * emoji/color, role tag, rail group — allowed on every bot, the Firstmate
 * included, because permanence protects its existence and not its name.
 *
 * `structuralRole` and template lineage are absent from `AdeUpdateBotIdentityInput`
 * by construction, so no client can spell a request that moves them.
 */
export const WsAdeUpdateBotIdentityRpc = Rpc.make(WS_METHODS.adeUpdateBotIdentity, {
  payload: AdeUpdateBotIdentityInput,
  success: Bot,
  error: AdeCaptainRpcError,
});

/** Create or rename/reorder one captain-defined contact group. */
export const WsAdeUpsertBotGroupRpc = Rpc.make(WS_METHODS.adeUpsertBotGroup, {
  payload: AdeUpsertBotGroupInput,
  success: AdeBotGroup,
  error: AdeCaptainRpcError,
});

/** Delete a group. Members fall to Ungrouped — this never deletes a bot. */
export const WsAdeDeleteBotGroupRpc = Rpc.make(WS_METHODS.adeDeleteBotGroup, {
  payload: AdeDeleteBotGroupInput,
  success: AdeDeletedBotGroup,
  error: AdeCaptainRpcError,
});

/**
 * Screen tab state (spec §4.6). A pure read: polling it must never provision
 * or start a desktop, because viewing never spawns.
 */
export const WsAdeGetBotScreenRpc = Rpc.make(WS_METHODS.adeGetBotScreen, {
  payload: AdeBotIdInput,
  success: AdeBotScreen,
  error: AdeCaptainRpcError,
});

/**
 * Resolves a bot to the workspace project its routines live on
 * (`docs/ade/MESSENGER-PIVOT.md` §4, M6). A pure read that creates nothing:
 * where chat *would* mint a missing workspace project, the rail reports
 * `"no-workspace-project"` and waits, because opening a side panel is not a
 * captain asking for a project.
 */
export const WsAdeGetBotRoutineContextRpc = Rpc.make(WS_METHODS.adeGetBotRoutineContext, {
  payload: AdeBotIdInput,
  success: AdeBotRoutineContext,
  error: AdeCaptainRpcError,
});

/** Explicit captain Start from the Screen tab; the only spawn path in the UI. */
export const WsAdeStartBotDesktopRpc = Rpc.make(WS_METHODS.adeStartBotDesktop, {
  payload: AdeBotIdInput,
  success: AdeBotScreen,
  error: AdeCaptainRpcError,
});

/** Explicit captain Stop; the home volume survives, so Start resumes the data. */
export const WsAdeStopBotDesktopRpc = Rpc.make(WS_METHODS.adeStopBotDesktop, {
  payload: AdeBotIdInput,
  success: AdeBotScreen,
  error: AdeCaptainRpcError,
});

/**
 * Confirm-gated bot delete (spec §4.6): destroy without snapshot, purge the
 * desktop's data, drop the provisioning record, then delete the bot row.
 */
export const WsAdeDeleteBotRpc = Rpc.make(WS_METHODS.adeDeleteBot, {
  payload: AdeBotIdInput,
  success: AdeDeletedBot,
  error: AdeCaptainRpcError,
});

/**
 * Create an ADE project and its Second Mate (spec §4.1). The empty-state CTA
 * lands here; without it the fleet has no projects, so crew can only ever be
 * fleet-wide and the auto-Second-Mate hook is unreachable.
 */
export const WsAdeCreateProjectRpc = Rpc.make(WS_METHODS.adeCreateProject, {
  payload: AdeCreateProjectInput,
  success: AdeCreatedProject,
  error: AdeCaptainRpcError,
});

/** Sidebar badge count of open Needs You items (slice 8). */
export const WsAdeGetNeedsYouCountRpc = Rpc.make(WS_METHODS.adeGetNeedsYouCount, {
  payload: Schema.Struct({}),
  success: AdeNeedsYouCount,
  error: AdeCaptainRpcError,
});

/**
 * The Needs You inbox (slice 5). One durable item, two renderings: this list
 * backs the inbox, and the same entries — filtered by subject — render inline
 * wherever the item's subject is on screen.
 */
export const WsAdeListNeedsYouRpc = Rpc.make(WS_METHODS.adeListNeedsYou, {
  payload: AdeListNeedsYouInput,
  success: AdeNeedsYouList,
  error: AdeCaptainRpcError,
});

/** One item, for the inbox detail pane and for post-decision re-reads. */
export const WsAdeGetNeedsYouItemRpc = Rpc.make(WS_METHODS.adeGetNeedsYouItem, {
  payload: AdeNeedsYouItemIdInput,
  success: AdeNeedsYouEntry,
  error: AdeCaptainRpcError,
});

/**
 * Approve or deny (spec §7 slice 5). The only RPC gated on `ade:approve`
 * (spec §5): both renderings call exactly this, so the durable item resolves
 * once no matter which one the captain used.
 */
export const WsAdeSubmitNeedsYouDecisionRpc = Rpc.make(WS_METHODS.adeSubmitNeedsYouDecision, {
  payload: AdeSubmitNeedsYouDecisionInput,
  success: AdeNeedsYouEntry,
  error: AdeCaptainRpcError,
});

/**
 * Chat bootstrap (slice 1): resolve — creating it on first use — the bot's
 * active primary-text session and hand back the thread the existing
 * conversation stack renders.
 */
export const WsAdeStartBotChatRpc = Rpc.make(WS_METHODS.adeStartBotChat, {
  payload: AdeBotIdInput,
  success: AdeBotChatSession,
  error: AdeCaptainRpcError,
});

/** Project view header + crew panel (slice 3, panel 1). */
export const WsAdeGetProjectRpc = Rpc.make(WS_METHODS.adeGetProject, {
  payload: AdeProjectIdInput,
  success: AdeProjectDetail,
  error: AdeCaptainRpcError,
});

/** Integration queue panel (slice 3, panel 2); the client owns status narrowing. */
export const WsAdeListProjectCandidatesRpc = Rpc.make(WS_METHODS.adeListProjectCandidates, {
  payload: AdeProjectIdInput,
  success: AdeProjectCandidates,
  error: AdeCaptainRpcError,
});

/**
 * Publication stack panel (slice 3, panel 3). Null when the project has never
 * published — a repo-bound project with no stack yet is the normal case, not
 * an error.
 */
export const WsAdeGetProjectPublicationStackRpc = Rpc.make(
  WS_METHODS.adeGetProjectPublicationStack,
  {
    payload: AdeProjectIdInput,
    success: Schema.NullOr(AdePublicationStackView),
    error: AdeCaptainRpcError,
  },
);

/**
 * One publication stack by its own id (MESSENGER-PIVOT §6 M5). Null when the
 * stack no longer exists — a card citing a retired stack shows the plain
 * assignment result, which is not an error.
 */
export const WsAdeGetPublicationStackRpc = Rpc.make(WS_METHODS.adeGetPublicationStack, {
  payload: AdePublicationStackIdInput,
  success: Schema.NullOr(AdePublicationStackView),
  error: AdeCaptainRpcError,
});

/** Assignment lineage for the work graph (slice 4); `projectId: null` is fleet-wide. */
export const WsAdeGetAssignmentGraphRpc = Rpc.make(WS_METHODS.adeGetAssignmentGraph, {
  payload: AdeAssignmentGraphInput,
  success: AdeAssignmentGraph,
  error: AdeCaptainRpcError,
});

export const WsRpcGroup = RpcGroup.make(
  WsAdeGetRosterRpc,
  WsAdeMarkBotChatReadRpc,
  WsAdeGetProjectRpc,
  WsAdeListProjectCandidatesRpc,
  WsAdeGetProjectPublicationStackRpc,
  WsAdeGetPublicationStackRpc,
  WsAdeGetAssignmentGraphRpc,
  WsAdeGetBotRpc,
  WsAdeCreateBotFromTemplateRpc,
  WsAdeCreateProjectRpc,
  WsAdeWriteBotMemoryRpc,
  WsAdeEditBotPersonaRpc,
  WsAdeSetBotComputerUseRpc,
  WsAdeUpdateBotIdentityRpc,
  WsAdeUpsertBotGroupRpc,
  WsAdeDeleteBotGroupRpc,
  WsAdeGetNeedsYouCountRpc,
  WsAdeListNeedsYouRpc,
  WsAdeGetNeedsYouItemRpc,
  WsAdeSubmitNeedsYouDecisionRpc,
  WsAdeStartBotChatRpc,
  WsAdeGetBotScreenRpc,
  WsAdeGetBotRoutineContextRpc,
  WsAdeStartBotDesktopRpc,
  WsAdeStopBotDesktopRpc,
  WsAdeDeleteBotRpc,
  WsAutomationsListRpc,
  WsAutomationsGetRpc,
  WsAutomationsCreateRpc,
  WsAutomationsUpdateRpc,
  WsAutomationsDeleteRpc,
  WsAutomationsRunNowRpc,
  WsAutomationsListRunsRpc,
  WsAutomationsValidateScheduleRpc,
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerGetUsageSummaryRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsVoiceGetControllerRpc,
  WsVoiceGetActiveCallRpc,
  WsVoiceGetControllerHistoryRpc,
  WsVoiceSetControllerTargetRpc,
  WsVoiceEnsureControllerRpc,
  WsVoiceListVoicesRpc,
  WsVoicePrepareThreadCallRpc,
  WsVoiceResetControllerRpc,
  WsVoiceStartRpc,
  WsVoiceIngestRealtimeEventRpc,
  WsVoiceAppendAudioRpc,
  WsVoiceStopRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsFetchRpc,
  WsVcsDescribeChangeRpc,
  WsVcsStartChangeRpc,
  WsVcsPushBookmarkRpc,
  WsVcsCreateChangeRequestRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsVcsSetProjectPreferenceRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsSubscribeAdeFleetHealthRpc,
  WsSubscribeAdeRosterRpc,
  WsSubscribeVoiceEventsRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetWorkflowScriptRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
