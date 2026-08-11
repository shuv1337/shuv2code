export function collapsedComposerActions(input: {
  readonly hasContent: boolean;
  readonly isRunning: boolean;
}): {
  readonly showSend: boolean;
  readonly showStop: boolean;
} {
  return {
    showSend: !input.isRunning || input.hasContent,
    showStop: input.isRunning,
  };
}
