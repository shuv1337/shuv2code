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
 * of `AdeBotRoutineContextReason` carrying three states instead of one: the fix
 * for "no repository" is not the fix for "no project", and telling a captain to
 * bind a repo to a project that does not exist is the failure #212 records on
 * the chat surface.
 *
 * Each reason writes both of its sentences in full — named project and
 * unnamed — rather than patching one string into the other. An earlier cut
 * substituted `"this bot's project"` by `String.replace`, which is a formatter
 * that fails silently: reword the base sentence and the project's name simply
 * stops appearing, with no test failing and nothing to notice in review.
 *
 * What each sentence may *say* narrowed in #217. The headline states the
 * state; the detail is the one next action and nothing else. The domain
 * lecture ("Routines run inside a project", "so its routines have somewhere to
 * run") and the description of what the UI will subsequently do ("That opens
 * its workspace, and routines can be added after") are both gone: the first is
 * a fact the captain cannot act on, the second narrates this app to its own
 * user.
 */
function emptyStateFor(
  reason: Exclude<AdeBotRoutineContextReason, "ready">,
  projectName: string | null,
): RoutinesEmptyState {
  switch (reason) {
    case "no-project":
      return { headline: "No project yet", detail: "Create a project for this bot." };
    case "no-repo-binding":
      return {
        headline: "No repository bound",
        detail:
          projectName === null
            ? "Add a repository path to this bot's project."
            : `Add a repository path to "${projectName}".`,
      };
    case "no-workspace-project":
      return {
        headline: "Workspace not opened yet",
        detail:
          projectName === null
            ? "Send this bot a message to open its workspace."
            : `Send this bot a message to open "${projectName}".`,
      };
  }
}

export function routinesEmptyState(context: AdeBotRoutineContext): RoutinesEmptyState | null {
  if (context.reason === "ready") return null;
  // `no-project` never names a project, even when a stale name is present:
  // there is no project for the captain to open.
  const projectName = context.reason === "no-project" ? null : context.projectName;
  return emptyStateFor(context.reason, projectName);
}

/**
 * While the rail is waiting on the orchestration shell rather than on the
 * captain. Distinct from an empty state: nothing is wrong and there is nothing
 * to fix, so it must not offer a remedy.
 */
export const ROUTINES_PENDING_PROJECT: RoutinesEmptyState = {
  headline: "Loading routines",
  detail: "",
};

/**
 * Whether the panel may create anything at all.
 *
 * `hasProject` is not redundant with the server's `reason`. The RPC answers
 * "which workspace project owns this bot's routines"; the *form* needs the
 * resolved `EnvironmentProject` from the orchestration shell, which arrives
 * separately and can lag. Gating the button on one and the form on the other is
 * what let a captain press Create Routine and get nothing at all — no form, no
 * explanation (D4). One predicate now answers for both.
 */
export function canCreateRoutine(
  context: AdeBotRoutineContext | null,
  hasProject: boolean,
): boolean {
  return context !== null && context.reason === "ready" && context.projectId !== null && hasProject;
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
