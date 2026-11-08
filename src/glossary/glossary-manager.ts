import { z } from 'zod';
import { hash, json } from '../storage/file-manager.js';
import type { SourceFile, Write } from '../storage/file-manager.js';
const category = z.enum(['character', 'alias', 'location', 'organization', 'technique', 'ability', 'rank', 'artifact', 'concept', 'title', 'honorific', 'relationship', 'other']);
const entrySchema = z.strictObject({
  translation: z.string().trim().min(1).max(300), category,
  status: z.enum(['auto', 'approved', 'review']), firstSeen: z.string(),
  alternatives: z.array(z.string()).default([]), confidence: z.number().min(0).max(1),
  contextDependent: z.boolean().default(false),
});
export const glossarySchema = z.record(z.string().min(1), entrySchema);
export type Glossary = z.infer<typeof glossarySchema>;
export const extractionSchema = z.strictObject({ terms: z.array(z.strictObject({
  source: z.string().trim().min(1).max(200), translation: z.string().trim().min(1).max(300),
  category, confidence: z.number().min(0).max(1), contextDependent: z.boolean(),
  rationale: z.string().max(1000),
})).max(100) });
export type Extraction = z.infer<typeof extractionSchema>;
export const reviewSchema = z.array(z.strictObject({
  id: z.string(), term: z.string(), established: z.string(), proposed: z.string(), chapter: z.string(),
  rationale: z.string(), contextDependent: z.boolean(), affectedChapters: z.array(z.string()),
}));
export type Reviews = z.infer<typeof reviewSchema>;
export const historySchema = z.strictObject({
  id: z.string(), action: z.enum(['add', 'conflict', 'manual-correction']), term: z.string(), chapter: z.string(),
  previous: z.string().nullable(), proposed: z.string().nullable(), affectedChapters: z.array(z.string()),
});
export type History = z.infer<typeof historySchema>[];
export const glossaryUseSchema = z.record(z.string(), z.strictObject({ translation: z.string(), contextDependent: z.boolean() }));
export type GlossaryUse = z.infer<typeof glossaryUseSchema>;
export function relevantGlossary(glossary: Glossary, source: string): Glossary {
  return Object.fromEntries(Object.entries(glossary).filter(([term]) => source.includes(term)));
}
export function glossaryUse(glossary: Glossary): GlossaryUse {
  return Object.fromEntries(Object.entries(glossary).map(([term, entry]) => [term, {
    translation: entry.translation, contextDependent: isContextDependent(entry),
  }]));
}
export function isContextDependent(entry: Glossary[string]): boolean {
  return entry.contextDependent || ['title', 'honorific', 'relationship'].includes(entry.category);
}
export function compatibleGlossary(used: GlossaryUse, current: Glossary): boolean {
  return Object.entries(used).every(([term, entry]) => {
    const now = current[term];
    return now !== undefined && now.translation === entry.translation && isContextDependent(now) === entry.contextDependent;
  });
}
export function mergeTerms(glossary: Glossary, reviews: Reviews, history: History,
  extraction: Extraction, chapter: SourceFile, allSources: SourceFile[]): { glossary: Glossary; reviews: Reviews; history: History; added: number } {
  const next = structuredClone(glossary), nextReviews = structuredClone(reviews), nextHistory = structuredClone(history);
  let added = 0;
  for (const proposed of extraction.terms) {
    if (!chapter.text.includes(proposed.source)) continue;
    const old = next[proposed.source];
    const affectedChapters = allSources.filter(s => s.text.includes(proposed.source)).map(s => s.name);
    const event = {
      id: hash({ chapter: chapter.name, sourceHash: chapter.sourceHash, term: proposed.source,
        established: old?.translation ?? null, translation: proposed.translation }),
      action: old ? 'conflict' as const : 'add' as const,
      term: proposed.source, chapter: chapter.name, previous: old?.translation ?? null,
      proposed: proposed.translation, affectedChapters,
    };
    if (!old) {
      next[proposed.source] = { translation: proposed.translation, category: proposed.category, status: 'auto',
        firstSeen: chapter.name, alternatives: [], confidence: proposed.confidence, contextDependent: proposed.contextDependent };
      nextHistory.push(event);
      added++;
    } else if (old.translation !== proposed.translation) {
      if (!old.alternatives.includes(proposed.translation)) old.alternatives.push(proposed.translation);
      if (old.status !== 'approved') old.status = 'review';
      if (!nextReviews.some(r => r.id === event.id)) nextReviews.push({ id: event.id, term: proposed.source,
        established: old.translation, proposed: proposed.translation, chapter: chapter.name,
        rationale: proposed.rationale, contextDependent: proposed.contextDependent || isContextDependent(old), affectedChapters });
      if (!nextHistory.some(h => h.id === event.id)) nextHistory.push(event);
    }
  }
  return { glossary: next, reviews: nextReviews, history: nextHistory, added };
}
export function glossaryWrites(glossary: Glossary, reviews: Reviews, history: History): Write[] {
  return [
    { path: 'context/glossary.json', content: json(glossary) },
    { path: 'context/glossary-review.json', content: json(reviews) },
    { path: 'context/glossary-history.jsonl', content: history.map(h => JSON.stringify(h)).join('\n') + (history.length ? '\n' : '') },
    { path: '.state/glossary-snapshot.json', content: json(glossary) },
  ];
}
export function recordManualCorrections(before: Glossary, after: Glossary, history: History, sources: SourceFile[]): History {
  const next = [...history];
  for (const [term, old] of Object.entries(before)) {
    const now = after[term];
    if (now?.translation === old.translation && isContextDependent(now) === isContextDependent(old)) continue;
    const event = { id: hash({ term, old, now }), action: 'manual-correction' as const,
      term, chapter: '(manual)', previous: old.translation, proposed: now?.translation ?? null,
      affectedChapters: sources.filter(s => s.text.includes(term)).map(s => s.name) };
    if (!next.some(e => e.id === event.id)) next.push(event);
  }
  return next;
}
