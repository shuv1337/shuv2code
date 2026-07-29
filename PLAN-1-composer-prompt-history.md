# Issue 1: Terminal-Style Composer Prompt History

## Context

- Issue: https://github.com/shuv1337/t3code/issues/1
- Upstream issue: https://github.com/pingdotgg/t3code/issues/1777
- Upstream reference implementation: https://github.com/pingdotgg/t3code/pull/4336
- Goal: while the chat composer is focused, let desktop users recall prior sent prompts with `ArrowUp` and return toward the current draft with `ArrowDown`.
- The desktop application renders the shared web composer. The implementation belongs in `apps/web`; no `apps/desktop` protocol or native-shell change is required.

## Current Behavior

- `apps/web/src/components/ComposerPromptEditor.tsx` registers high-priority Lexical commands for `ArrowUp`, `ArrowDown`, `Enter`, and `Tab`, forwarding them to `onCommandKeyDown`. A handled command already prevents the browser default and stops propagation.
- `apps/web/src/components/chat/ChatComposer.tsx` handles autocomplete navigation before send behavior in `onComposerCommandKey`. It owns the controlled prompt, cursor, trigger, draft-store integration, pending-input state, and editor handle needed for history navigation.
- `apps/web/src/components/ChatView.tsx` builds `timelineMessages` from server messages plus unacknowledged optimistic user messages. `ChatComposer` currently receives `activeThread`, whose `messages` do not include those optimistic messages.
- The composer draft is persisted per `composerDraftTarget` by `composerDraftStore.ts`. Recalling history must not permanently replace an unsent draft when the user navigates back to the live entry or switches threads.
- Sent `ChatMessage.text` is a wire payload, not necessarily the original editable prompt. `ChatView.tsx` may append terminal contexts, element contexts, preview annotations, review comments, an image-only bootstrap prompt, and a provider-controlled effort prefix before dispatch.
- The timeline already projects portions of that wire payload for display with `deriveDisplayedUserMessageState`, `extractTrailingPreviewAnnotation`, and `parseReviewCommentMessageSegments`. Raw `message.text` must not be copied directly into history.

## Issue Review

The requested `ArrowUp` binding is useful but underspecified for a multiline rich-text composer. A safe terminal-style interaction also needs:

- `ArrowDown` so the user can move toward newer entries and restore the original unsent draft.
- First/last visual-line gating so arrows retain normal caret movement within hard-wrapped and soft-wrapped multiline prompts.
- Autocomplete priority so `@`, `$`, `/`, and path menus continue using arrows.
- Per-thread state and cleanup so switching threads cannot leak history or overwrite either thread's saved draft.
- Optimistic-message support so pressing `ArrowUp` immediately after send recalls the prompt that was just submitted.
- Projection from wire messages to editable text so generated XML/context payloads are never inserted into the composer.

Do not cherry-pick upstream PR 4336 as-is. Its open review identifies three applicable defects: raw wire-payload recall, loss of the saved draft when the message list shrinks, and omission of the just-sent optimistic message.

## Decisions

- History is scoped to the current thread and derived from `timelineMessages`, ordered oldest to newest.
- Include non-empty user-authored text only. Skip assistant/system messages, context-only messages, and the synthetic image-only bootstrap prompt.
- Collapse only consecutive duplicate prompts. This avoids redundant key presses while preserving repeated prompts separated by other commands.
- `ArrowUp` enters history at the newest entry, then moves older. `ArrowDown` moves newer and, after the newest entry, restores the exact draft captured when history browsing began.
- Editing a recalled prompt exits browse mode and keeps the edited text as the live draft. A later `ArrowUp` starts a fresh history traversal.
- A thread change, unmount, send/reset, or history-list invalidation exits browse mode. If the user has not edited the recalled value, restore the captured draft before leaving the old target.
- Entry into history runs only with a collapsed selection, no modifier keys, no IME composition, no active composer trigger/menu (including a loading or zero-result menu), no approval or pending-user-input flow, and no attached terminal-context chips. Once already browsing, only an actually visible menu takes priority; trigger-like suffixes in recalled text must not strand traversal.
- Preserve the current structured attachments while recalling text, except terminal contexts. Terminal contexts are disabled because their inline placeholders and payload array must stay synchronized. Images, element contexts, preview annotations, and review comments remain untouched because this issue changes only the text field.
- Do not add a `History k/n` label in the smallest scope. The issue requests keyboard behavior, and an indicator is not required for discoverability or correctness.
- Keep history in memory. Existing thread messages remain the durable source; do not add local storage, server schema, settings, or keybinding configuration.
- Do not strip ambiguous user text such as a literal `Ultrathink:` prefix unless existing metadata proves it was generated. Strip only recognized generated blocks and the exact synthetic image-only fallback.

## Architecture

### Prompt Projection

Add a small pure helper module at `apps/web/src/components/chat/composerPromptHistory.ts` that:

- Accepts the current `ReadonlyArray<ChatMessage>`.
- Selects user messages in timeline order.
- Converts each wire payload to recallable text by reversing known send-time append operations:
  - remove parsed review-comment segments while retaining ordinary text segments;
  - repeatedly remove trailing preview-annotation blocks;
  - remove trailing element and terminal context blocks through the existing parsing helpers;
  - reject the exact image-only bootstrap fallback when no authored text remains;
  - trim only serialization boundary whitespace, not internal formatting.
- Drops empty entries and consecutive duplicates.
- Exposes pure index/direction helpers for moving older/newer and identifying return to the live draft.

Keep this module independent of React and DOM APIs so projection and traversal can be exhaustively unit-tested.

### Composer Integration

- Pass `timelineMessages` from `ChatView.tsx` to `ChatComposer` as a narrow prompt-history input. Do not make `ChatComposer` reconstruct the optimistic merge.
- In `ChatComposer.tsx`, derive projected entries with `useMemo` and maintain only browsing state:
  - current history index (`null` means the live draft);
  - captured live draft;
  - exact recalled value, used to distinguish controlled recall updates from user/external edits.
- Apply recalled text through the existing `promptRef`, `setPrompt`, `setComposerCursor`, and `setComposerTrigger` paths, placing the caret at the end and closing any stale trigger state.
- Integrate history after visible autocomplete-menu handling and before Enter submission in `onComposerCommandKey`.
- Use `ComposerPromptEditorHandle.readSnapshot()` for source text and expanded cursor. Use the current DOM `Selection`/`Range` for collapsed-selection and caret geometry checks. Combine logical newline checks with the caret rectangle to recognize first/last visual lines without hijacking arrows inside wrapped text.
- Return `true` only when history actually handles the key so `ComposerCommandKeyPlugin` owns `preventDefault` and propagation consistently.

## Implementation Tasks

### 1. Add Tested Prompt-History Logic

Create:

- `apps/web/src/components/chat/composerPromptHistory.ts`
- `apps/web/src/components/chat/composerPromptHistory.test.ts`

Implement and test:

- wire-message projection for plain, multiline, terminal-context, element-context, preview-annotation, review-comment, and image-only messages;
- immediate optimistic messages by treating the input as the already-merged timeline list;
- user-role filtering, empty filtering, ordering, and consecutive deduplication;
- older/newer traversal boundaries and transition back to the captured live draft;
- list shrink/invalidation behavior that signals draft restoration rather than silently adopting a recalled value.

Acceptance criteria:

- No generated context wrapper or synthetic fallback appears in a projected history entry.
- Internal newlines and authored whitespace remain semantically intact.
- Traversal behavior is deterministic and has no React or browser dependency.

### 2. Wire History Into the Composer

Modify:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`

Changes:

- Add a narrow `promptHistoryMessages` prop populated from `timelineMessages`.
- Add per-target browse refs/state and a single recall function that updates prompt, cursor, and trigger atomically.
- Restore the captured draft on `ArrowDown` past the newest entry and on an unedited thread-switch/list-invalidation cleanup.
- Exit browse mode without restoring when the user edits the recalled text.
- Reset browse state after send through the existing composer reset path.
- Add multiline visual-edge detection and all keyboard/state gates listed in Decisions.
- Preserve existing autocomplete `ArrowUp`/`ArrowDown`, `Shift+Tab`, Enter-submit, pending input, approval, and mobile behavior.

Acceptance criteria:

- Empty or single-line composer plus `ArrowUp` recalls the newest prompt, including immediately after send and before server acknowledgement.
- Repeated `ArrowUp` walks older entries; repeated `ArrowDown` walks newer entries and restores the original unsent draft.
- At the oldest entry, further `ArrowUp` does not wrap.
- Editing a recalled value leaves it as an ordinary draft and exits traversal.
- Hard-newline and soft-wrap prompts retain ordinary arrow navigation except at the first/last visual line.
- Thread switches never expose another thread's history and never replace that thread's pre-existing draft with a recalled entry.
- Autocomplete menus retain arrow-key priority.
- A loading or zero-result `@`, `$`, `/`, or path trigger blocks entry into history instead of replacing the partial query.
- A recalled entry ending in trigger-like text can still navigate older/newer when no popup is visible.
- Modifier chords, IME composition, expanded selections, pending questions, approvals, and terminal-context drafts do not invoke history.

### 3. Focused Verification

Run:

```sh
vp test run apps/web/src/components/chat/composerPromptHistory.test.ts
vp lint apps/web/src/components/chat/composerPromptHistory.ts apps/web/src/components/chat/composerPromptHistory.test.ts apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/ChatView.tsx
vp fmt --check apps/web/src/components/chat/composerPromptHistory.ts apps/web/src/components/chat/composerPromptHistory.test.ts apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/ChatView.tsx
vp run --filter @shuv2code/web typecheck
git diff --check
```

Expected signals:

- The focused history suite passes all projection and traversal cases.
- Lint, formatting, typecheck, and diff checks exit successfully.

Then load the `test-shuv2code-app` skill and run one isolated integrated web pass. Seed or send at least three distinguishable prompts, including one multiline prompt and one prompt with generated context metadata. Verify:

- immediate post-send recall;
- older/newer traversal and live-draft restoration;
- normal caret movement inside multiline and soft-wrapped text;
- autocomplete arrow navigation;
- thread-switch draft preservation;
- no generated metadata in recalled text;
- the same flow at desktop width and no regression to composer use at mobile width.

Stop the isolated development environment after verification.

## Out Of Scope

- Persisting a separate shell-history database.
- Cross-thread or cross-project history.
- History search, fuzzy filtering, deletion, or a visible history picker.
- Configurable shortcuts or settings UI.
- Recalling prior attachments or reconstructing historical terminal/element/annotation payloads.
- Native desktop or mobile code changes.

## Risks And Mitigations

- **Raw metadata recall:** centralize wire-to-editable projection and cover every current append format with focused tests.
- **Draft loss:** capture the live draft once on entering browse mode and explicitly restore it on forward exit and unedited invalidation/target cleanup.
- **Missing just-sent message:** consume `timelineMessages`, not `activeThread.messages`.
- **Multiline cursor regression:** require both logical first/last hard-line position and visual caret-edge position before handling arrows.
- **Autocomplete regression:** retain visible-menu handling as the first arrow-key consumer.
- **Controlled-editor feedback loop:** track the exact recalled value so the prompt synchronization effect can distinguish recall from a real edit.
- **Context desynchronization:** disable history while terminal-context placeholders are attached and never mutate attachment collections during text recall.

## Rollback

Revert the `promptHistoryMessages` prop, the history state/key branch in `ChatComposer.tsx`, and the pure helper/test files. No migration, persisted format, protocol, or server rollback is required.

## Done When

- Every acceptance criterion above is met.
- Focused automated checks pass.
- The integrated isolated web flow passes on the shared browser/Electron surface.
- Issue 1 can be closed with no server, contract, database, or native desktop changes.
