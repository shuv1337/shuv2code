import type { ModelSelection } from "@shuv2code/contracts";
import { getModelSelectionStringOptionValue } from "@shuv2code/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const VoiceCallIdentity = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  projectId: Schema.String,
  durableProviderInstanceId: Schema.String,
  durableModel: Schema.String,
  durableAgent: Schema.NullOr(Schema.String),
  transportProviderInstanceId: Schema.String,
  transportModel: Schema.String,
});
export type VoiceCallIdentity = typeof VoiceCallIdentity.Type;

const decodeVoiceCallIdentity = Schema.decodeUnknownOption(VoiceCallIdentity);

export function makeVoiceCallIdentity(input: {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectId: string;
  readonly durableModelSelection: ModelSelection;
  readonly transportModelSelection: ModelSelection;
}): VoiceCallIdentity {
  return {
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    projectId: input.projectId,
    durableProviderInstanceId: input.durableModelSelection.instanceId,
    durableModel: input.durableModelSelection.model,
    durableAgent: getModelSelectionStringOptionValue(input.durableModelSelection, "agent") ?? null,
    transportProviderInstanceId: input.transportModelSelection.instanceId,
    transportModel: input.transportModelSelection.model,
  };
}

export function voiceCallIdentityFromProvenance(
  provenance: Readonly<Record<string, unknown>> | undefined,
): VoiceCallIdentity | undefined {
  if (provenance?.actorKind !== "voice-call") return undefined;
  return Option.getOrUndefined(decodeVoiceCallIdentity(provenance.callIdentity));
}

export function formatVoiceCallIdentity(identity: VoiceCallIdentity): string {
  return [
    "Authoritative app-owned Call attachment:",
    `- Thread ID: ${identity.threadId}`,
    `- Thread title: ${identity.threadTitle}`,
    `- Project ID: ${identity.projectId}`,
    `- Durable provider instance: ${identity.durableProviderInstanceId}`,
    `- Durable model: ${identity.durableModel}`,
    `- Durable agent/profile: ${identity.durableAgent ?? "provider default"}`,
    `- Realtime voice transport provider: ${identity.transportProviderInstanceId}`,
    `- Realtime voice transport model: ${identity.transportModel}`,
    "These identities are supplied by the application and are authoritative for this Call. Distinguish the durable worker from the Realtime voice transport. Answer identity questions directly from this block; never infer identity from model behavior, nearby threads, or unrelated session records.",
  ].join("\n");
}
