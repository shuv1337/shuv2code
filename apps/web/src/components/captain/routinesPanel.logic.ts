/**
 * Pure view mapping for the right rail's Routines section
 * (`docs/ade/MESSENGER-PIVOT.md` §2/§4, M6).
 *
 * A routine *is* a `project_automations` row — same scheduler, same run
 * history, same form. This module owns only the two questions the rail asks
 * that Settings never does: what to say when a bot cannot have routines yet,
 * and how to order/label rows that may belong to the bot or to its project.
 */
import type {
  AdeBotRoutineContext,
  AdeBotRoutineContextReason,
  BotId,
  ProjectAutomationSummary,
} from "@shuv2code/contracts";

export interface RoutinesEmptyState {
  readonly headline: string;
  readonly detail: string;
}

/**
 * What the rail says when there is no project to hang routines on, keyed by
 * the server's reason rather than inferred from a null id.
 *
 * Each sentence names the remedy that actually exists. That is the whole point
 * of `AdeBotRoutineContextReason` carrying three states instead of one: the
 * fix for "no repository" is not the fix for "no project", and telling a
 * captain to bind a repo to a project that does not exist is the failure #212
 * records on the chat surface.
 */
const EMPTY_STATE: Record<Exclude<AdeBotRoutineContextReason, "ready">, RoutinesEmptyState> = {
  "no-project": {
    headline: "No project yet",
    detail: "Routines run inside a project. Create one, then this bot can hold routines.",
  },
  "no-repo-binding": {
    headline: "No repository bound",
    detail: "Add a repository path to this bot's project so its routines have somewhere to run.",
  },
  "no-workspace-project": {
    headline: "Workspace not opened yet",
    detail:
      "Send this bot a message once. That opens its workspace, and routines can be added after.",
  },
};

export function routinesEmptyState(context: AdeBotRoutineContext): RoutinesEmptyState | null {
  if (context.reason === "ready") return null;
  const base = EMPTY_STATE[context.reason];
  if (context.projectName === null || context.reason === "no-project") return base;
  // Naming the project turns "add a repository path" from an instruction into
  // an address. It is omitted for `no-project` precisely because there is no
  // project to name.
  return {
    headline: base.headline,
    detail: base.detail.replace("this bot's project", `"${context.projectName}"`),
  };
}

/** Whether the panel may create anything at all. */
export function canCreateRoutine(context: AdeBotRoutineContext | null): boolean {
  return context !== null && context.reason === "ready" && context.projectId !== null;
}

export interface RoutineRowView {
  readonly id: ProjectAutomationSummary["id"];
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: string;
  /** True when the row names this bot; false when it is the project's. */
  readonly ownedByBot: boolean;
  /** Shown only on project-wide rows, so the bot's own rows stay uncluttered. */
  readonly scopeLabel: string | null;
  readonly promptPreview: string;
}

/**
 * Rows for one bot's rail: its own routines first, then the project's.
 *
 * The server already filters to "this bot or unattributed" — this only orders
 * and labels. Ordering by ownership rather than by time is deliberate: the
 * rail is a short list a captain scans for *their* bot's schedule, and a
 * project-wide nightly job created last week should not sit above the routine
 * they added to this bot an hour ago. Within each group the server's order
 * (created ascending) is preserved, so the list does not reshuffle as rows are
 * enabled and disabled.
 */
export function getRoutineRowViews(input: {
  readonly automations: ReadonlyArray<ProjectAutomationSummary>;
  readonly botId: BotId;
}): ReadonlyArray<RoutineRowView> {
  const rows = input.automations.map((automation): RoutineRowView => {
    const ownedByBot = automation.botId === input.botId;
    return {
      id: automation.id,
      name: automation.name,
      enabled: automation.enabled,
      schedule: `${automation.cronExpression} · ${automation.timeZone}`,
      ownedByBot,
      scopeLabel: ownedByBot ? null : "Project",
      promptPreview: automation.promptPreview,
    };
  });
  const own = rows.filter((row) => row.ownedByBot);
  const shared = rows.filter((row) => !row.ownedByBot);
  return [...own, ...shared];
}

/**
 * The count line under the section header. Phrased from the bot's side because
 * that is whose panel this is: "3 routines, 1 shared" reads as a fact about
 * this bot, where "3 automations" reads as a fact about the project.
 */
export function routinesSummaryLabel(rows: ReadonlyArray<RoutineRowView>): string {
  if (rows.length === 0) return "No routines yet";
  const shared = rows.filter((row) => !row.ownedByBot).length;
  const total = rows.length === 1 ? "1 routine" : `${rows.length} routines`;
  return shared === 0 ? total : `${total}, ${shared} shared with the project`;
}
