/**
 * Pure view mapping for the fleet roster (spec §7 slice 2). The server owns
 * the order — Firstmate, then the other coordinators, then crew — so nothing
 * here re-sorts; it only decides what each row says.
 */
import type { AdeBotTemplateSummary, AdeRoster, AdeRosterEntry, BotId } from "@shuv2code/contracts";

import { structuralRoleLabel } from "../../state/ade.logic";

export interface RosterRowView {
  readonly botId: BotId;
  readonly name: string;
  readonly roleLabel: string;
  readonly roleTag: string;
  readonly projectLabel: string;
  /** The Firstmate is pinned at the top and marked; it is never archivable. */
  readonly isFirstmate: boolean;
  readonly openAssignmentLabel: string | null;
  /** A warm session is resumed rather than started (spec §4.1 lazy sessions). */
  readonly chatLabel: string;
}

export function getRosterRowView(entry: AdeRosterEntry): RosterRowView {
  return {
    botId: entry.bot.id,
    name: entry.bot.name,
    roleLabel: structuralRoleLabel(entry.bot.structuralRole),
    roleTag: entry.bot.roleTag,
    projectLabel: entry.projectName ?? "Fleet-wide",
    isFirstmate: entry.bot.structuralRole === "firstmate",
    openAssignmentLabel:
      entry.openAssignmentCount <= 0
        ? null
        : entry.openAssignmentCount === 1
          ? "1 open assignment"
          : `${entry.openAssignmentCount} open assignments`,
    chatLabel: entry.hasActivePrimarySession ? "Resume chat" : "Chat",
  };
}

export function getRosterRowViews(roster: AdeRoster | null): ReadonlyArray<RosterRowView> {
  return roster === null ? [] : roster.entries.map(getRosterRowView);
}

/**
 * Whether to show the #141 first-run CTA. Only once the roster has actually
 * answered: telling a captain to create a project they already have is the one
 * wrong thing an empty state can say.
 */
export function rosterNeedsFirstProject(roster: AdeRoster | null): boolean {
  return roster !== null && roster.projects.length === 0;
}

export function templateOptionLabel(template: AdeBotTemplateSummary): string {
  return template.defaultName === template.roleTag
    ? template.defaultName
    : `${template.defaultName} · ${template.roleTag}`;
}
