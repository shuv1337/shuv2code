import type { UsageProviderKind } from "@shuv2code/contracts";

import { type Icon, OpenAI } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart, table, legend, and skeleton, so
 * adding a provider only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--foreground)",
    mark: OpenAI,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** The chart layers every series from zero, so order only controls how it is read. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];
