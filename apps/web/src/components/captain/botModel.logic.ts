/**
 * View logic for the bot model setting (`docs/ade/MESSENGER-PIVOT.md` §3 —
 * the identity sheet's "everything about this bot" surface).
 *
 * The setting exists because a bot's model used to be whatever the kernel
 * happened to list first: a free model that emits pseudo-XML instead of tool
 * calls, or — after a cache clear — an image model whose turns failed with
 * nothing to read. Two things follow from that history and are encoded here.
 *
 * First, a model that does not report tool calling is **listed and
 * selectable**, marked rather than hidden. Capability data is provider
 * reported and can be stale or absent for a model the captain knows works, and
 * a picker that silently drops entries reproduces the original bug from the
 * other direction — the captain cannot tell whether the model is missing or
 * merely unlisted.
 *
 * Second, the copy never says "saved" alone. A live kernel session keeps the
 * model it was created with, so the outcome of a save is either "running it
 * now" or "applies next time", and the server is the one that knows which.
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type AdeBotModelSetting,
  type BotExecutionBinding,
  type ProviderInstanceId,
  type ServerProvider,
} from "@shuv2code/contracts";
import { isAgentCapableModel } from "@shuv2code/shared/model";

/** The shuvcode driver instance every ADE bot runs on (spec §1). */
export const ADE_MODEL_INSTANCE_ID: ProviderInstanceId = defaultInstanceIdForDriver(
  ProviderDriverKind.make("opencodeV2"),
);

/** Shown beside a model the kernel reports as unable to run an agent. */
export const BOT_MODEL_UNSUPPORTED_HINT = "May not support tools";

/** Under the picker, always — the default path is the dormant one. */
export const BOT_MODEL_NEXT_SESSION_NOTE = "Applies the next time this conversation is restarted.";

/**
 * On the opt-in restart control. The deferral is named because it is a real
 * outcome the captain can hit: a restart while the bot is running a fleet tool
 * would leave that call to be re-requested and run a second time, so the
 * server declines it and the saved message says the bot kept its model.
 */
export const BOT_MODEL_RESTART_NOTE =
  "Restarts this bot's session so the new model takes effect now. A reply in flight is interrupted, and a restart is deferred while the bot is running a fleet tool.";

export interface BotModelOption {
  readonly slug: string;
  readonly label: string;
  /**
   * False only when the kernel actively reported that this model cannot call
   * tools or cannot answer in text. Unreported is `true` — see
   * `isAgentCapableModel`.
   */
  readonly agentCapable: boolean;
  /** The kernel's own configured `model:`, when it named one of these. */
  readonly isKernelDefault: boolean;
}

/**
 * Every shuvcode model, capable ones first.
 *
 * Sorted rather than filtered: the flagged entries stay reachable at the
 * bottom of the list, which is what makes "the captain knows better than the
 * capability block" an option instead of a dead end. Order is otherwise the
 * kernel's own (release date descending), so the grouping is the only opinion
 * this adds.
 */
export function getBotModelOptions(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<BotModelOption> {
  const instance = providers.find((provider) => provider.instanceId === ADE_MODEL_INSTANCE_ID);
  const options = (instance?.models ?? []).map((model) => ({
    slug: model.slug,
    label: model.name.trim().length > 0 ? model.name : model.slug,
    agentCapable: isAgentCapableModel(model),
    isKernelDefault: model.isDefault === true,
  }));
  return [
    ...options.filter((option) => option.agentCapable),
    ...options.filter((option) => !option.agentCapable),
  ];
}

/**
 * What to render where the bot's current model goes.
 *
 * A bot with no pin is not broken — it runs whatever the resolution ladder
 * picks — so the empty state names that rather than reading as a missing
 * value.
 */
export function getBotModelLabel(
  options: ReadonlyArray<BotModelOption>,
  slug: string | null | undefined,
): string {
  if (slug === null || slug === undefined || slug.length === 0) return "Kernel default";
  return options.find((option) => option.slug === slug)?.label ?? slug;
}

/**
 * Is this slug one the kernel reported as unfit to drive a bot?
 *
 * A slug the picker has never heard of is *not* flagged: an unknown model is
 * unreported, not refused, and the server accepts it on the same reasoning.
 */
export function isFlaggedBotModel(
  options: ReadonlyArray<BotModelOption>,
  slug: string | null | undefined,
): boolean {
  if (slug === null || slug === undefined) return false;
  const option = options.find((candidate) => candidate.slug === slug);
  return option !== undefined && !option.agentCapable;
}

/**
 * Is there a session that would keep the old model until it is restarted?
 *
 * This is what decides whether the restart control is offered at all: with no
 * active primary binding the setting is already in force on the next turn, and
 * a "restart" button there would be an act with nothing to act on.
 */
export function hasLivePrimarySession(bindings: ReadonlyArray<BotExecutionBinding>): boolean {
  return bindings.some(
    (binding) => binding.purpose === "primary-text" && binding.status === "active",
  );
}

/** Nothing to send when the captain re-picks what the bot already runs. */
export function shouldSubmitBotModel(
  current: string | null | undefined,
  next: string | null,
  restartSession: boolean,
): next is string {
  if (next === null || next.length === 0) return false;
  return restartSession || next !== (current ?? null);
}

/**
 * The one line the captain reads after a save. It always states which of the
 * two outcomes happened, because "Saved." on its own is exactly the message
 * that let a dormant model change look like a live one.
 */
export function getBotModelSavedMessage(setting: AdeBotModelSetting): string {
  return setting.appliesToLiveSession
    ? `Saved. This bot runs on ${setting.modelSelection.model} from its next turn.`
    : `Saved. This bot keeps its current model until this conversation is restarted, then runs on ${setting.modelSelection.model}.`;
}
