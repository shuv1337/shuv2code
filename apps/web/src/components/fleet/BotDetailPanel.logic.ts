/**
 * Pure view mapping for the bot detail panel (spec §7 slice 2): bindings,
 * memory, persona history.
 */
import type {
  AdeBotDetail,
  BotExecutionBinding,
  BotExecutionBindingId,
  PersonaVersion,
  PersonaVersionId,
} from "@shuv2code/contracts";

import { structuralRoleLabel } from "../../state/ade.logic";

/**
 * A persona edit is recorded as a new version and adopted when the bot's next
 * session starts (ADR §12.1) — never mid-conversation. Saying so is the whole
 * point of the note; a captain who expects an immediate change is owed it.
 */
export const PERSONA_EDIT_NOTE = "Takes effect at this bot's next session.";

export interface BotHeaderView {
  readonly name: string;
  readonly roleLabel: string;
  readonly roleTag: string;
  readonly projectLabel: string;
  readonly computerUse: boolean;
  readonly isFirstmate: boolean;
}

export function getBotHeaderView(detail: AdeBotDetail): BotHeaderView {
  return {
    name: detail.bot.name,
    roleLabel: structuralRoleLabel(detail.bot.structuralRole),
    roleTag: detail.bot.roleTag,
    projectLabel: detail.projectName ?? "Fleet-wide",
    computerUse: detail.bot.computerUse,
    isFirstmate: detail.bot.structuralRole === "firstmate",
  };
}

export interface BindingRowView {
  readonly id: BotExecutionBindingId;
  readonly engine: string;
  readonly purpose: string;
  readonly status: BotExecutionBinding["status"];
  readonly statusVariant: "success" | "secondary" | "error";
  readonly sessionId: string;
  readonly updatedAt: string;
}

const BINDING_PURPOSE_LABELS: Record<BotExecutionBinding["purpose"], string> = {
  "primary-text": "Primary chat",
  "parallel-work": "Parallel work",
  voice: "Voice",
  "specialized-work": "Specialized work",
};

const BINDING_STATUS_VARIANTS: Record<
  BotExecutionBinding["status"],
  BindingRowView["statusVariant"]
> = {
  active: "success",
  historical: "secondary",
  lost: "error",
};

/** Active bindings first — those are the sessions a captain can act on. */
export function getBindingRowViews(
  bindings: ReadonlyArray<BotExecutionBinding>,
): ReadonlyArray<BindingRowView> {
  return bindings
    .map(
      (binding): BindingRowView => ({
        id: binding.id,
        engine: binding.engine,
        purpose: BINDING_PURPOSE_LABELS[binding.purpose],
        status: binding.status,
        statusVariant: BINDING_STATUS_VARIANTS[binding.status],
        sessionId: binding.sessionId,
        updatedAt: binding.updatedAt,
      }),
    )
    .toSorted((left, right) => {
      if (left.status !== right.status) {
        return left.status === "active" ? -1 : right.status === "active" ? 1 : 0;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

export interface PersonaVersionView {
  readonly id: PersonaVersionId;
  readonly content: string;
  readonly createdAt: string;
  /** `pending` heads have never been adopted by a session yet (ADR §12.1). */
  readonly stateLabel: "Active" | "Pending" | "Superseded";
}

/**
 * Newest first, as the server sends them. The head is the version that will be
 * adopted next; it is `Pending` until a session has actually started on it.
 */
export function getPersonaVersionViews(
  versions: ReadonlyArray<PersonaVersion>,
  activePersonaVersionId: PersonaVersionId | null,
): ReadonlyArray<PersonaVersionView> {
  return versions.map((version) => ({
    id: version.id,
    content: version.content,
    createdAt: version.createdAt,
    stateLabel:
      version.id === activePersonaVersionId
        ? "Active"
        : version.activatedAt === null
          ? "Pending"
          : "Superseded",
  }));
}

/**
 * Whether the Save button should do anything. Saving text identical to what the
 * server holds would burn a write and a new `updatedAt` for nothing.
 */
export function canSaveMemory(input: {
  readonly draft: string;
  readonly saved: string | null;
  readonly busy: boolean;
}): boolean {
  return !input.busy && input.saved !== null && input.draft !== input.saved;
}
