/**
 * SpeedRead Core. Pure TypeScript (erasable syntax only, so Node runs it with
 * type stripping and the Claude Code mod host imports it as is).
 * No DOM, Node or Claude-specific APIs.
 *
 * A document is made of logical blocks, each holding displayable words.
 * Code blocks are held for manual advance rather than RSVP-flashed.
 */

export const DEFAULT_WPM = 350;
export const MIN_WPM = 100;
export const MAX_WPM = 900;
export const WPM_STEP = 25;

export type BlockKind = 'paragraph' | 'heading' | 'list' | 'quote' | 'table' | 'code';

export type Block = {
  kind: BlockKind;
  text: string;
  words: string[];
  /** Fence info string of a code block (`ts`, `python`), when given. */
  lang?: string;
};

export type Position = { blockIndex: number; wordIndex: number };

export type ReaderDocument = Position & {
  id: number | string;
  raw: string;
  blocks: Block[];
  totalWords: number;
};

/** Pause weights relative to one word's base interval. Settings, not magic. */
export type TimingProfile = {
  sentence: number;
  clause: number;
  longWord: number;
  longWordChars: number;
  blockEnd: number;
};

export const DEFAULT_TIMING: TimingProfile = {
  sentence: 1.8,
  clause: 1.4,
  longWord: 1.3,
  longWordChars: 12,
  blockEnd: 1.5,
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function setWpm(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? clamp(Math.round(number / WPM_STEP) * WPM_STEP, MIN_WPM, MAX_WPM)
    : DEFAULT_WPM;
}

export function cleanInline(text: unknown): string {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\((?:[^)]*)\)/gu, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/<[^>\n]+>/gu, '')
    .replace(/\*\*|__|~~|\*/gu, '')
    .trim();
}

function block(kind: BlockKind, text: string, lang?: string): Block | null {
  const cleaned = kind === 'code' ? String(text).trimEnd() : cleanInline(text);
  if (!cleaned.trim()) return null;
  const b: Block = {
    kind,
    text: cleaned,
    words: kind === 'code' ? [] : cleaned.match(/\S+/gu) ?? [],
  };
  if (kind === 'code' && lang) b.lang = lang;
  return b;
}

const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/u;

// Split Markdown by *logical* boundaries, not by terminal line-wrap.
export function parseBlocks(raw: unknown): Block[] {
  const lines = String(raw ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const blocks: Block[] = [];
  let pending: string[] = [];
  let codeLines: string[] = [];
  let inCode = false;
  let fence = '';
  let lang = '';
  const push = (b: Block | null) => { if (b) blocks.push(b); };
  const flush = () => {
    if (!pending.length) return;
    push(block('paragraph', pending.join(' ').replace(/\s+/gu, ' ')));
    pending = [];
  };
  const flushCode = () => {
    push(block('code', codeLines.join('\n'), lang));
    codeLines = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/u);
    if (inCode) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) {
        inCode = false;
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      inCode = true;
      fence = fenceMatch[1]!;
      lang = fenceMatch[2]!.trim().split(/\s+/u)[0] ?? '';
      continue;
    }
    if (!trimmed) { flush(); continue; }
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/u);
    if (heading) { flush(); push(block('heading', heading[1]!)); continue; }
    const quote = trimmed.match(/^>\s?(.*)$/u);
    if (quote) { flush(); push(block('quote', quote[1]!)); continue; }
    const list = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/u);
    if (list) { flush(); push(block('list', list[1]!)); continue; }
    if (/^\|.*\|\s*$/u.test(trimmed)) {
      flush();
      if (!TABLE_DIVIDER.test(trimmed)) {
        const cells = trimmed.slice(1, -1).split('|').map(c => c.trim()).filter(Boolean);
        push(block('table', cells.join(' · ')));
      }
      continue;
    }
    pending.push(trimmed);
  }
  flush();
  if (inCode) flushCode();
  return blocks;
}

export function makeDocument(text: unknown, id: number | string = 'latest'): ReaderDocument {
  const raw = String(text ?? '');
  const blocks = parseBlocks(raw);
  return {
    id,
    raw,
    blocks,
    totalWords: blocks.reduce((sum, b) => sum + b.words.length, 0),
    blockIndex: 0,
    wordIndex: 0,
  };
}

export function activeBlock(doc: ReaderDocument | null | undefined): Block | null {
  return doc?.blocks?.[doc.blockIndex] ?? null;
}

export function activeWord(doc: ReaderDocument | null | undefined): string | null {
  const b = activeBlock(doc);
  if (!doc || !b || b.kind === 'code') return null;
  return b.words[doc.wordIndex] ?? null;
}

/** True when the active word is the last word of its block. */
export function atBlockEnd(doc: ReaderDocument): boolean {
  const b = activeBlock(doc);
  return !!b && b.kind !== 'code' && doc.wordIndex >= b.words.length - 1;
}

export function elapsedWordMs(
  word: string | null | undefined,
  wpm: number = DEFAULT_WPM,
  options: { blockEnd?: boolean; timing?: TimingProfile } = {},
): number {
  const t = options.timing ?? DEFAULT_TIMING;
  const base = 60000 / setWpm(wpm);
  const str = String(word ?? '');
  let factor = /[.!?…。！？]["'»”)）」]*$/u.test(str) ? t.sentence
    : /[,;:、，；：]["'»”)）」]*$/u.test(str) ? t.clause
    : 1;
  if ([...str].length >= t.longWordChars) factor = Math.max(factor, t.longWord);
  if (options.blockEnd) factor = Math.max(factor, t.blockEnd);
  return Math.round(base * factor);
}

/**
 * Optimal recognition point: the index (in code points) of the letter the eye
 * should fix on, ignoring leading punctuation.
 */
export function orpIndex(word: string): number {
  const chars = [...word];
  let start = 0;
  while (start < chars.length - 1 && /[\p{P}\p{S}]/u.test(chars[start]!)) start++;
  let end = chars.length;
  while (end - 1 > start && /[\p{P}\p{S}]/u.test(chars[end - 1]!)) end--;
  const len = end - start;
  const offset = len <= 1 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : len <= 13 ? 3 : 4;
  return start + offset;
}

/**
 * Splits a word around its ORP and pads the left side so the pivot letter
 * always lands in column `pivotColumn` (0-based). Pure string work, so every
 * renderer (terminal, web, iOS) aligns identically.
 */
export function orpParts(word: string, pivotColumn = 8): { pad: string; before: string; pivot: string; after: string } {
  const chars = [...word];
  const i = orpIndex(word);
  const before = chars.slice(0, i).join('');
  return {
    pad: ' '.repeat(Math.max(0, pivotColumn - i)),
    before,
    pivot: chars[i] ?? '',
    after: chars.slice(i + 1).join(''),
  };
}

// Advance ONE word (not multiple) so the reader never silently skips content on lag.
export function advanceOne(doc: ReaderDocument): boolean {
  if (!doc?.blocks.length) return false;
  const b = activeBlock(doc);
  if (!b || b.kind === 'code') return false;
  if (doc.wordIndex < b.words.length - 1) {
    doc.wordIndex += 1;
    return true;
  }
  if (doc.blockIndex < doc.blocks.length - 1) {
    doc.blockIndex += 1;
    doc.wordIndex = 0;
    return true;
  }
  return false;
}

export function previousOne(doc: ReaderDocument): boolean {
  if (!doc?.blocks.length) return false;
  if (doc.wordIndex > 0) {
    doc.wordIndex -= 1;
    return true;
  }
  if (doc.blockIndex > 0) {
    doc.blockIndex -= 1;
    const b = activeBlock(doc)!;
    doc.wordIndex = Math.max(0, b.words.length - 1);
    return true;
  }
  return false;
}

export function jumpBlock(doc: ReaderDocument, delta: number): boolean {
  if (!doc?.blocks?.length) return false;
  const nextIndex = clamp(doc.blockIndex + delta, 0, doc.blocks.length - 1);
  const changed = nextIndex !== doc.blockIndex;
  doc.blockIndex = nextIndex;
  doc.wordIndex = 0;
  return changed;
}

/** Moves to a position, clamped into the document. */
export function seek(doc: ReaderDocument, pos: Position): void {
  if (!doc.blocks.length) { doc.blockIndex = 0; doc.wordIndex = 0; return; }
  doc.blockIndex = clamp(Math.trunc(pos.blockIndex) || 0, 0, doc.blocks.length - 1);
  const b = doc.blocks[doc.blockIndex]!;
  doc.wordIndex = clamp(Math.trunc(pos.wordIndex) || 0, 0, Math.max(0, b.words.length - 1));
}

export function isFinished(doc: ReaderDocument): boolean {
  return doc.blockIndex === doc.blocks.length - 1 && atBlockEnd(doc);
}

export function progress(doc: ReaderDocument | null | undefined): number {
  if (!doc || !doc.totalWords) return 0;
  const before = doc.blocks.slice(0, doc.blockIndex).reduce((s, b) => s + b.words.length, 0);
  return clamp((before + doc.wordIndex + 1) / doc.totalWords, 0, 1);
}
