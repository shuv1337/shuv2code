/**
 * Pure detector/parser for the assignment-result synthetic input the server
 * delivers into a bot's session (spec §13.5; rendered by
 * `renderAssignmentDeliveryText` in `apps/server/src/ade/AdeAssignmentEngine.ts`).
 *
 * The delivery arrives as an ordinary user turn, so without this it reads as a
 * wall of fenced markdown. Parsing is deliberately strict: anything that is not
 * byte-for-byte the shape the engine renders returns `null` and is left to
 * render as the plain text it is. A captain typing something that merely looks
 * like a delivery must not be repainted as one.
 */

/** Mirrors `UNTRUSTED_CONTENT_OPEN`/`CLOSE` in `AdeSessionRollover.ts`. */
const FENCE_OPEN = "<<<untrusted-content>>>";
const FENCE_CLOSE = "<<</untrusted-content>>>";

const SINGLE_HEADER = "An assignment you delegated has finished.";
const MULTI_HEADER = /^(\d+) assignments you delegated have finished\.$/;
const WAIT_NOTE = /^These complete the children you were waiting on for assignment (.+)\.$/;
const BLOCK_HEADER = /^### Assignment (.+) — (completed|failed|cancelled) \(bot (.+)\)$/;
const BLOCK_HEADER_PREFIX = "### Assignment ";

export interface ParsedAssignmentDeliveryItem {
  readonly assignmentId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly recipientBotId: string;
  readonly instruction: string;
  readonly summary: string;
  /** Already-rendered artifact lines; the engine flattens the typed union. */
  readonly artifacts: ReadonlyArray<string>;
}

export interface ParsedAssignmentDelivery {
  /** Set when this batch unblocks a parent that was waiting on its children. */
  readonly parentAssignmentId: string | null;
  readonly assignments: ReadonlyArray<ParsedAssignmentDeliveryItem>;
}

/**
 * The structured form of one `Artifacts:` line, recovered from the string the
 * engine flattened it into.
 *
 * Mirrors the `ArtifactRef` union in `packages/contracts/src/ade.ts` and the
 * `renderArtifact` switch in `AdeAssignmentEngine.ts`. Kept beside
 * {@link parseAssignmentDeliveryText} on purpose: both halves of the engine's
 * text contract live in one file, so a change to the rendering breaks a test
 * here rather than silently degrading a card somewhere else.
 */
export type ParsedAssignmentArtifact =
  | { readonly kind: "jjChange"; readonly changeId: string; readonly projectId: string }
  | { readonly kind: "publicationLayer"; readonly stackId: string; readonly layerId: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "url"; readonly href: string };

const JJ_CHANGE_ARTIFACT = /^jj change (\S+) \(project (\S+)\)$/;
const PUBLICATION_LAYER_ARTIFACT = /^publication layer (\S+) \(stack (\S+)\)$/;
const FILE_ARTIFACT = /^file (.+)$/;
const URL_ARTIFACT = /^url (.+)$/;

/**
 * Recovers one artifact reference from its rendered line, or `null` when the
 * line is not a shape `renderArtifact` can produce.
 *
 * Strict for the same reason the delivery parser is strict: a summary sentence
 * that happens to start with "file " must not be promoted into a typed artifact
 * and given an Open action that points nowhere.
 */
export function parseAssignmentArtifactLine(line: string): ParsedAssignmentArtifact | null {
  const jjChange = JJ_CHANGE_ARTIFACT.exec(line);
  if (jjChange !== null) {
    return {
      kind: "jjChange",
      changeId: jjChange[1] as string,
      projectId: jjChange[2] as string,
    };
  }
  const layer = PUBLICATION_LAYER_ARTIFACT.exec(line);
  if (layer !== null) {
    return {
      kind: "publicationLayer",
      stackId: layer[2] as string,
      layerId: layer[1] as string,
    };
  }
  const file = FILE_ARTIFACT.exec(line);
  if (file !== null) {
    return { kind: "file", path: file[1] as string };
  }
  const url = URL_ARTIFACT.exec(line);
  if (url !== null) {
    return { kind: "url", href: url[1] as string };
  }
  return null;
}

/**
 * Every artifact across a delivery's assignments, in first-seen order, with the
 * lines that did not parse dropped. Unparsed lines are *not* an error: the
 * `AssignmentResultCard` still shows them verbatim, and this function only
 * feeds surfaces that need the typed form.
 */
export function parseAssignmentDeliveryArtifacts(
  delivery: ParsedAssignmentDelivery,
): ReadonlyArray<ParsedAssignmentArtifact> {
  const parsed: Array<ParsedAssignmentArtifact> = [];
  for (const assignment of delivery.assignments) {
    for (const line of assignment.artifacts) {
      const artifact = parseAssignmentArtifactLine(line);
      if (artifact !== null) {
        parsed.push(artifact);
      }
    }
  }
  return parsed;
}

/** Reads `OPEN\n…\nCLOSE` starting at `index`; null when it is not there. */
function readFence(
  lines: ReadonlyArray<string>,
  index: number,
): { readonly content: string; readonly next: number } | null {
  if (lines[index] !== FENCE_OPEN) {
    return null;
  }
  const close = lines.indexOf(FENCE_CLOSE, index + 1);
  if (close === -1) {
    return null;
  }
  return { content: lines.slice(index + 1, close).join("\n"), next: close + 1 };
}

function parseBlock(lines: ReadonlyArray<string>): ParsedAssignmentDeliveryItem | null {
  const header = BLOCK_HEADER.exec(lines[0] ?? "");
  if (header === null) {
    return null;
  }
  if (lines[1] !== "Instruction:") {
    return null;
  }
  const instruction = readFence(lines, 2);
  if (instruction === null) {
    return null;
  }
  if (lines[instruction.next] !== "Summary:") {
    return null;
  }
  const summary = readFence(lines, instruction.next + 1);
  if (summary === null) {
    return null;
  }
  let cursor = summary.next;
  const artifacts: Array<string> = [];
  if (lines[cursor] === "Artifacts:") {
    cursor += 1;
    while (cursor < lines.length && lines[cursor]?.startsWith("- ") === true) {
      artifacts.push((lines[cursor] as string).slice(2));
      cursor += 1;
    }
    // The engine emits at least one line under the heading; a bare heading is
    // not a shape it can produce.
    if (artifacts.length === 0) {
      return null;
    }
  }
  // Anything trailing means this is not a delivery block after all.
  if (cursor !== lines.length) {
    return null;
  }
  return {
    assignmentId: header[1] as string,
    status: header[2] as ParsedAssignmentDeliveryItem["status"],
    recipientBotId: header[3] as string,
    instruction: instruction.content,
    summary: summary.content,
    artifacts,
  };
}

/**
 * Splits the body into per-assignment blocks. Fence-aware, so an instruction
 * that itself contains a `### Assignment …` line does not start a new block.
 */
function splitBlocks(lines: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> {
  const blocks: Array<Array<string>> = [];
  let inFence = false;
  for (const line of lines) {
    if (line === FENCE_OPEN) {
      inFence = true;
    } else if (line === FENCE_CLOSE) {
      inFence = false;
    } else if (!inFence && line.startsWith(BLOCK_HEADER_PREFIX)) {
      blocks.push([line]);
      continue;
    }
    const current = blocks[blocks.length - 1];
    if (current === undefined) {
      // Content before the first header cannot belong to any block.
      return [];
    }
    current.push(line);
  }
  // Blocks are joined by a blank line, which lands at the end of each but the
  // last; dropping it keeps `parseBlock` exact about trailing content.
  return blocks.map((block) =>
    block[block.length - 1] === "" ? block.slice(0, block.length - 1) : block,
  );
}

/**
 * Returns the structured delivery when `text` is exactly what the assignment
 * engine renders, and `null` for every other turn.
 */
export function parseAssignmentDeliveryText(text: string): ParsedAssignmentDelivery | null {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const multi = MULTI_HEADER.exec(first);
  if (first !== SINGLE_HEADER && multi === null) {
    return null;
  }
  const expected = multi === null ? 1 : Number(multi[1]);
  let cursor = 1;
  const wait = WAIT_NOTE.exec(lines[cursor] ?? "");
  if (wait !== null) {
    cursor += 1;
  }
  if (lines[cursor] !== "") {
    return null;
  }
  const blocks = splitBlocks(lines.slice(cursor + 1));
  if (blocks.length !== expected || expected === 0) {
    return null;
  }
  const assignments: Array<ParsedAssignmentDeliveryItem> = [];
  for (const block of blocks) {
    const parsed = parseBlock(block);
    if (parsed === null) {
      return null;
    }
    assignments.push(parsed);
  }
  return { parentAssignmentId: wait === null ? null : (wait[1] as string), assignments };
}
