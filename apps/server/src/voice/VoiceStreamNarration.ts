import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "@shuv2code/contracts";

const MIN_CHUNK_CHARS = 48;
const MAX_CHUNK_CHARS = 420;
const MAX_BUFFER_CHARS = 8_192;

interface StreamBuffer {
  readonly itemId: string | null;
  readonly text: string;
  readonly emittedChunks: number;
}

export interface VoiceStreamNarrationState {
  readonly assistant: StreamBuffer;
  readonly reasoningSummary: StreamBuffer;
  readonly assistantSpokenSinceBoundary: boolean;
}

export interface VoiceStreamNarrationChunk {
  readonly key: string;
  readonly text: string;
  readonly source: "assistant" | "reasoning-summary";
  readonly turnId: ProviderRuntimeEvent["turnId"] | null;
  readonly terminal: boolean;
}

export interface VoiceStreamNarrationUpdate {
  readonly state: VoiceStreamNarrationState;
  readonly chunks: ReadonlyArray<VoiceStreamNarrationChunk>;
}

export type VoiceStreamNarrationMode = "streaming" | "final-only";

const emptyBuffer = (): StreamBuffer => ({ itemId: null, text: "", emittedChunks: 0 });

export const initialVoiceStreamNarrationState = (): VoiceStreamNarrationState => ({
  assistant: emptyBuffer(),
  reasoningSummary: emptyBuffer(),
  assistantSpokenSinceBoundary: false,
});

const speechText = (raw: string): string => {
  const withoutCode = raw.replaceAll(/```[\s\S]*?```/g, " ").replace(/```[\s\S]*$/g, " ");
  return withoutCode
    .split("\n")
    .filter((line) => {
      const pipes = line.match(/\|/g)?.length ?? 0;
      return pipes < 2 && !/^\s*[-:| ]{3,}\s*$/.test(line);
    })
    .join(" ")
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll(/https?:\/\/\S+/g, "")
    .replaceAll(/^\s{0,3}#{1,6}\s+/gm, "")
    .replaceAll(/^\s*[-*+]\s+/gm, "")
    .replaceAll(/`([^`]+)`/g, "$1")
    .replaceAll(/[*_~]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
};

const sentenceEnds = (text: string): ReadonlyArray<number> =>
  Array.from(
    text.matchAll(/[.!?](?:["')\]]+)?(?=\s|$)/g),
    (match) => match.index + match[0].length,
  );

function chunkEnd(text: string, emittedChunks: number, force: boolean): number | null {
  if (text.length === 0) return null;
  const ends = sentenceEnds(text);
  if (force) {
    const sentenceEnd = ends[0];
    if (sentenceEnd !== undefined && sentenceEnd <= MAX_CHUNK_CHARS) return sentenceEnd;
    const paragraphEnd = text.indexOf("\n\n");
    if (paragraphEnd >= 16 && paragraphEnd <= MAX_CHUNK_CHARS) return paragraphEnd;
    if (text.length <= MAX_CHUNK_CHARS) return text.length;
    const whitespace = text.lastIndexOf(" ", MAX_CHUNK_CHARS);
    return whitespace >= MIN_CHUNK_CHARS ? whitespace : MAX_CHUNK_CHARS;
  }
  const minimumSentenceCount = emittedChunks === 0 ? 2 : 1;
  const sentenceEnd = ends[minimumSentenceCount - 1];
  const paragraphEnd = text.indexOf("\n\n");
  const candidates = [
    sentenceEnd,
    paragraphEnd >= MIN_CHUNK_CHARS ? paragraphEnd : undefined,
  ].filter((value): value is number => value !== undefined && value >= MIN_CHUNK_CHARS);
  if (candidates.length > 0) return Math.min(...candidates);
  if (text.length < MAX_CHUNK_CHARS) return null;
  const boundedSentenceEnd = ends.findLast((end) => end <= MAX_CHUNK_CHARS);
  if (boundedSentenceEnd !== undefined) return boundedSentenceEnd;
  const whitespace = text.lastIndexOf(" ", MAX_CHUNK_CHARS);
  return whitespace >= MIN_CHUNK_CHARS ? whitespace : MAX_CHUNK_CHARS;
}

function drainBuffer(
  initial: StreamBuffer,
  force: boolean,
  source: VoiceStreamNarrationChunk["source"],
  turnId: ProviderRuntimeEvent["turnId"] | null,
  terminal: boolean,
): { readonly buffer: StreamBuffer; readonly chunks: ReadonlyArray<VoiceStreamNarrationChunk> } {
  let buffer = initial;
  const chunks: Array<VoiceStreamNarrationChunk> = [];
  while (buffer.text.length > 0) {
    const end = chunkEnd(buffer.text, buffer.emittedChunks, force);
    if (end === null) break;
    const raw = buffer.text.slice(0, end);
    const text = speechText(raw);
    const itemId = buffer.itemId ?? "turn";
    const emittedChunks = buffer.emittedChunks + 1;
    buffer = {
      itemId: buffer.itemId,
      text: buffer.text.slice(end).trimStart(),
      emittedChunks,
    };
    if (text.length >= 16) {
      chunks.push({
        key: `${source}:${itemId}:${emittedChunks}`,
        text,
        source,
        turnId,
        terminal,
      });
    }
    if (force) break;
  }
  return { buffer, chunks };
}

const appendDelta = (
  buffer: StreamBuffer,
  event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>,
): StreamBuffer => {
  const itemId = event.itemId ?? `turn:${event.turnId ?? "unknown"}`;
  return buffer.itemId === null || buffer.itemId === itemId
    ? {
        ...buffer,
        itemId,
        text: `${buffer.text}${event.payload.delta}`.slice(-MAX_BUFFER_CHARS),
      }
    : { itemId, text: event.payload.delta.slice(-MAX_BUFFER_CHARS), emittedChunks: 0 };
};

export function reduceVoiceStreamNarration(
  state: VoiceStreamNarrationState,
  event: ProviderRuntimeEvent,
  mode: VoiceStreamNarrationMode = "streaming",
): VoiceStreamNarrationUpdate {
  const turnId = event.turnId ?? null;
  if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
    const appended = appendDelta(state.assistant, event);
    const drained =
      mode === "streaming"
        ? drainBuffer(appended, false, "assistant", turnId, false)
        : { buffer: appended, chunks: [] };
    return {
      state: {
        ...state,
        assistant: drained.buffer,
        assistantSpokenSinceBoundary:
          state.assistantSpokenSinceBoundary || drained.chunks.length > 0,
      },
      chunks: drained.chunks,
    };
  }
  if (event.type === "content.delta" && event.payload.streamKind === "reasoning_summary_text") {
    return {
      state: { ...state, reasoningSummary: appendDelta(state.reasoningSummary, event) },
      chunks: [],
    };
  }
  if (event.type === "item.started" && isToolLifecycleItemType(event.payload.itemType)) {
    // A reasoning header is only a fallback. Emitting it at every tool boundary
    // races ordinary assistant commentary and floods Realtime with tiny prompts.
    // Keep it buffered until the turn ends, when we know no assistant message followed.
    return {
      state,
      chunks: [],
    };
  }
  if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
    const drained = drainBuffer(state.assistant, true, "assistant", turnId, true);
    return {
      state: {
        ...state,
        assistant: emptyBuffer(),
        assistantSpokenSinceBoundary:
          state.assistantSpokenSinceBoundary || drained.chunks.length > 0,
      },
      chunks: drained.chunks,
    };
  }
  if (event.type === "turn.completed" || event.type === "turn.aborted") {
    const assistant = drainBuffer(state.assistant, true, "assistant", turnId, true);
    const fallback =
      state.assistantSpokenSinceBoundary || assistant.chunks.length > 0
        ? { buffer: emptyBuffer(), chunks: [] }
        : drainBuffer(state.reasoningSummary, true, "reasoning-summary", turnId, true);
    return {
      state: initialVoiceStreamNarrationState(),
      chunks: [...assistant.chunks, ...fallback.chunks],
    };
  }
  return { state, chunks: [] };
}
