# CONTEXT

Ubiquitous language for shuv2code / ADE. Terms only — shapes and mechanics live in
[docs/ade/ADE-V1-SPEC.md](docs/ade/ADE-V1-SPEC.md); rationale lives in the
[ADR](https://github.com/shuv1337/psychoharness/blob/main/ADE-FORK-DECISION.md).

## ADE

- **ADE** — the Agent Development Environment: the captain-facing fleet product built into shuv2code, additive to the existing coding-tool UX.
- **Captain** — the human operator. The only non-bot actor; the sole approver.
- **Kernel** — a bounded execution engine ADE binds to: **shuvcode** (primary text) or **Codex** (coordinator specializations + voice). Screenbox is a runtime, not a kernel.
- **Bot** — a durable, engine-neutral identity with a persona, memory, role, and execution bindings. Not a session.
- **Firstmate** — the permanent workspace-level coordinator bot; the home conversation. Exactly one; cannot be deleted.
- **Second Mate** — a project's coordinator bot, auto-created with the project.
- **Crew** — the bots attached to a project.
- **Persona** — an ADE-owned versioned document projected into a bot's sessions at creation; edits take effect next session.
- **Memory document** — a bot's single bounded self-written, captain-editable durable memory.
- **Execution binding** — the link from a bot to one kernel session, with a purpose (primary-text, parallel-work, voice, specialized-work).
- **Assignment** — the first-class unit of delegated work: instruction in, structured completion out, FIFO-queued per bot, with lineage.
- **Steer** — redirecting a running session without cancelling it. Distinct from **cancel** (explicit, cascade by command only).
- **Synthetic input** — content delivered into a kernel session by ADE rather than typed by the captain (assignment results, notifications, voice summaries).
- **Dynamic tools** — session-scoped tools ADE registers at session start; the primary tool plane. Invocation arrival on the owning connection is what attributes it (structural attribution).
- **Controller gate** — the dispatch layer resolving a tool invocation to {bot, session} and running inline checks. Not a policy engine.
- **Needs You** — the captain's attention queue: approvals, kernel-down, stalls, provision failures, forms. One durable item, rendered in the inbox and inline.
- **Integration** — serialized, policy-gated landing of assignment work into a project's canonical repo, one candidate at a time.
- **Integration candidate** — one unit of work moving through the integration gate.
- **Publication** — pushing integrated work to GitHub as a stacked-PR series; separate from integration.
- **Publication stack / layer** — the durable record of a stacked-PR series and its per-PR layers.
- **Screenbox** — the upstream desktop-container runtime giving a bot a computer; one desktop per bot, provisioned on first need.
- **Computer use** — the per-bot toggle granting Screenbox tools.
- **Walking skeleton** — the first end-to-end build milestone: chat with Firstmate, delegate an assignment, receive its result.
- **Strip** — the provider removal (OpenCode v1, Grok, Cursor, Claude) that opens the build; Codex + shuvcode remain.

## Repo / VCS

- **JJ workspace** — an isolated Jujutsu working copy for parallel assignment work; canonical repo stays untouched until integration.
- **Converge-then-act** — the publication invariant: every pass starts by fetching remote truth before mutating anything.
