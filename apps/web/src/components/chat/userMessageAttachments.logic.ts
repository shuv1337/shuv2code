/**
 * Attachment selection for a user message, shared by the IDE timeline row and
 * the captain messenger's bubble.
 *
 * Pure and component-free so the messenger's `bubbleTimeline.logic` can reuse
 * it without dragging React into a DOM-less test.
 *
 * The attachment shape is structural on purpose: both callers pass the same
 * provider attachments, and neither surface should have to import the other's
 * row types to decide what a thumbnail is.
 */
export interface UserMessageAttachment {
  readonly type?: "image" | "file";
  readonly id: string;
  readonly name: string;
  readonly previewUrl?: string;
}

/** Preview-annotation crops are drawn by their card, not by the plain grid. */
export function isPreviewAnnotationAttachment(attachment: UserMessageAttachment): boolean {
  return attachment.type === "image" && attachment.name.startsWith("preview-annotation-");
}

export function selectUserMessageImages<T extends UserMessageAttachment>(
  attachments: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return attachments.filter(
    (attachment) => attachment.type === "image" && !isPreviewAnnotationAttachment(attachment),
  );
}

export function selectUserMessagePreviewAnnotationImages<T extends UserMessageAttachment>(
  attachments: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return attachments.filter(isPreviewAnnotationAttachment);
}

export function selectUserMessageFiles<T extends UserMessageAttachment>(
  attachments: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return attachments.filter((attachment) => attachment.type === "file");
}
