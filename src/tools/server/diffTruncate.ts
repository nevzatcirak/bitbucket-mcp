/**
 * Smart per-file diff truncation: keep the head 60% and tail 40% of the
 * (size-capped) preview and report what was omitted, so agents see both the
 * beginning and the end of large diffs without flooding the context.
 */

import { asRecord, asString, truncateString } from "../../core/json.js";

export type DiffMarker = "+" | "-" | " ";

export interface RawDiffLine {
  readonly marker: DiffMarker;
  readonly text: string;
}

export interface FileDiffCard {
  readonly source: string | null;
  readonly destination: string | null;
  readonly changeType: string | null;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly truncated: boolean;
  readonly omittedLines: number;
  readonly preview: string;
}

/** Extract marker+text lines from a Server/DC diff hunk tree. */
export function extractDiffLines(diff: unknown): RawDiffLine[] {
  const lines: RawDiffLine[] = [];
  const hunks = asRecord(diff)?.hunks;
  if (!Array.isArray(hunks)) return lines;
  for (const hunk of hunks) {
    const segments = asRecord(hunk)?.segments;
    if (!Array.isArray(segments)) continue;
    for (const segment of segments) {
      const type = asString(asRecord(segment)?.type) ?? "";
      const marker: DiffMarker = type === "ADDED" ? "+" : type === "REMOVED" ? "-" : " ";
      const segmentLines = asRecord(segment)?.lines;
      if (!Array.isArray(segmentLines)) continue;
      for (const line of segmentLines) {
        const text = asString(asRecord(line)?.content) ?? asString(asRecord(line)?.text) ?? "";
        lines.push({ marker, text });
      }
    }
  }
  return lines;
}

/**
 * Truncate a text block: head 60% + tail 40% of the allowed budget.
 * Returns the block text plus statistics about what was omitted.
 */
export function truncateTextBlock(
  lines: readonly string[],
  maxChars: number,
): { text: string; truncated: boolean; omittedLines: number } {
  const joined = lines.join("\n");
  if (joined.length <= maxChars) {
    return { text: joined, truncated: false, omittedLines: 0 };
  }
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = Math.max(0, maxChars - headBudget);

  let consumed = 0;
  let headEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const width = lines[i].length + (i > 0 ? 1 : 0); // +1 for the join newline
    if (consumed + width > headBudget) break;
    consumed += width;
    headEnd = i + 1;
  }

  let tailStart = lines.length;
  let tailConsumed = 0;
  for (let i = lines.length - 1; i >= headEnd; i--) {
    const width = lines[i].length + 1; // +1 for the join newline
    if (tailConsumed + width > tailBudget) break;
    tailConsumed += width;
    tailStart = i;
  }

  const head = lines.slice(0, headEnd);
  const tail = tailStart < lines.length ? lines.slice(tailStart) : [];
  const omitted = lines.length - head.length - tail.length;
  const parts: string[] = [];
  if (head.length > 0) parts.push(head.join("\n"));
  if (omitted > 0) parts.push(`… ${omitted} line(s) omitted …`);
  if (tail.length > 0) parts.push(tail.join("\n"));
  return { text: truncateString(parts.join("\n"), maxChars), truncated: true, omittedLines: omitted };
}

/** Project one raw Server/DC diff entry into a compact, truncated card. */
export function projectDiffFile(diff: unknown, maxChars: number): FileDiffCard {
  const record = asRecord(diff);
  const rawLines = extractDiffLines(diff);
  const textLines = rawLines.map((l) => `${l.marker}${l.text}`);
  const added = rawLines.filter((l) => l.marker === "+").length;
  const removed = rawLines.filter((l) => l.marker === "-").length;
  const { text, truncated, omittedLines } = truncateTextBlock(textLines, maxChars);

  return {
    source: asString(record?.source) ?? (asString(getPathString(record, "source")) ?? null),
    destination: asString(record?.destination) ?? (asString(getPathString(record, "destination")) ?? null),
    changeType: asString(record?.changeType),
    addedLines: added,
    removedLines: removed,
    truncated,
    omittedLines,
    preview: text,
  };
}

function getPathString(record: Record<string, unknown> | null, key: string): string | null {
  const nested = asRecord(record?.[key]);
  return asString(nested?.toString);
}
