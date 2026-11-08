import { getEncoding } from 'js-tiktoken';
import type { Config } from '../config.js';
import { hash } from '../storage/file-manager.js';
export interface Paragraph { id: string; text: string; separator: string }
export interface Fragment { id: string; paragraphId: string; text: string }
export interface Chunk { id: string; fragments: Fragment[]; sourceHash: string }
export interface Document { prefix: string; paragraphs: Paragraph[]; chunks: Chunk[] }
export class TokenCounter {
  private readonly encoding;
  constructor(encoding: Config['tokenEncoding']) { this.encoding = getEncoding(encoding); }
  count(text: string): number { return this.encoding.encode(text, [], []).length; }
  tail(text: string, budget: number): string {
    if (budget === 0) return '';
    const points = Array.from(text);
    let low = 0, high = points.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.count(points.slice(-mid).join('')) <= budget) low = mid; else high = mid - 1;
    }
    return points.slice(points.length - low).join('');
  }
}
function splitOversized(text: string, budget: number, counter: TokenCounter): string[] {
  const points = Array.from(text);
  const result: string[] = [];
  let start = 0;
  while (start < points.length) {
    let low = start + 1, high = points.length, end = start;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (counter.count(points.slice(start, mid).join('')) <= budget) { end = mid; low = mid + 1; }
      else high = mid - 1;
    }
    if (end === start) throw new Error('Chunk budget too small for a Unicode character');
    result.push(points.slice(start, end).join(''));
    start = end;
  }
  return result;
}
export function chunkDocument(text: string, budget: number, counter: TokenCounter): Document {
  const matches = [...text.matchAll(/[^\r\n]+/g)].filter(m => m[0].trim());
  const paragraphs: Paragraph[] = matches.map((m, index) => {
    const end = (m.index ?? 0) + m[0].length;
    const next = matches[index + 1]?.index ?? text.length;
    return { id: `p${String(index + 1).padStart(6, '0')}`, text: m[0], separator: text.slice(end, next) };
  });
  const chunks: Chunk[] = [];
  let current: Fragment[] = [];
  const flush = () => {
    if (current.length) {
      const sourceHash = hash(current);
      chunks.push({ id: `c${String(chunks.length + 1).padStart(5, '0')}-${sourceHash.slice(0, 12)}`, fragments: current, sourceHash });
      current = [];
    }
  };
  // Include identifier/JSON overhead in the chunk budget, not only source prose.
  const contentBudget = Math.max(1, budget - 24);
  for (const paragraph of paragraphs) {
    const sentences = counter.count(paragraph.text) <= contentBudget ? [paragraph.text]
      : [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(paragraph.text)].map(s => s.segment);
    const pieces = sentences.flatMap(s => counter.count(s) <= contentBudget ? [s] : splitOversized(s, contentBudget, counter));
    for (const [part, piece] of pieces.entries()) {
      const fragment = { id: `${paragraph.id}-s${part + 1}`, paragraphId: paragraph.id, text: piece };
      if (counter.count(JSON.stringify([...current, fragment])) > budget && current.length) flush();
      // JSON escaping can expand unusually formatted text; split again with actual overhead.
      if (counter.count(JSON.stringify([fragment])) > budget) {
        const overhead = counter.count(JSON.stringify([{ ...fragment, text: '' }])) + 8;
        const smaller = splitOversized(piece, Math.max(1, budget - overhead), counter);
        for (const [sub, value] of smaller.entries()) {
          flush();
          current = [{ ...fragment, id: `${fragment.id}-${sub + 1}`, text: value }];
          if (counter.count(JSON.stringify(current)) > budget) throw new Error('chunkSizeTokens too small for paragraph identifiers; increase it');
          flush();
        }
      } else current.push(fragment);
    }
  }
  flush();
  return { prefix: text.slice(0, matches[0]?.index ?? text.length), paragraphs, chunks };
}
export function renderDocument(document: Document, translations: Map<string, string>): string {
  const byParagraph = new Map<string, string[]>();
  for (const chunk of document.chunks) for (const fragment of chunk.fragments) {
    const translated = translations.get(fragment.id);
    if (translated === undefined) throw new Error(`Missing translated fragment: ${fragment.id}`);
    const parts = byParagraph.get(fragment.paragraphId) ?? [];
    parts.push(translated);
    byParagraph.set(fragment.paragraphId, parts);
  }
  return document.prefix + document.paragraphs.map(p => (byParagraph.get(p.id) ?? []).join('') + p.separator).join('');
}
