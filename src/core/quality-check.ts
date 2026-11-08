import { z } from 'zod';
import type { Chunk } from './chunker.js';
import type { Glossary } from '../glossary/glossary-manager.js';
import { isContextDependent } from '../glossary/glossary-manager.js';
import { ProviderError } from '../providers/types.js';
export const translationSchema = z.strictObject({ paragraphs: z.array(z.strictObject({
  id: z.string().min(1), text: z.string().min(1),
})) });
export type Translation = z.infer<typeof translationSchema>;
export function validateTranslation(chunk: Chunk, translated: Translation, glossary: Glossary, linguistic = true): string[] {
  const expected = chunk.fragments.map(f => f.id), actual = translated.paragraphs.map(p => p.id);
  if (new Set(actual).size !== actual.length || expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
    throw new ProviderError('Missing, duplicate, reordered, or unexpected paragraph identifiers', true);
  }
  for (const p of translated.paragraphs) {
    if (!p.text.trim() || /[\r\n]/.test(p.text) || p.text.includes('```')) {
      throw new ProviderError('Empty translation, unexpected paragraph break, or Markdown wrapper', true);
    }
  }
  const warnings: string[] = [];
  if (!linguistic) return warnings;
  const source = chunk.fragments.map(f => f.text).join('\n');
  const target = translated.paragraphs.map(p => p.text).join('\n');
  if (source.length > 40 && target.length < source.length * 0.2) warnings.push('Suspiciously short translation; inspect for omissions');
  for (const [term, entry] of Object.entries(glossary)) {
    if (!isContextDependent(entry) && source.includes(term) && !target.includes(entry.translation)) {
      warnings.push(`Possible terminology inconsistency: ${term} → ${entry.translation}`);
    }
  }
  return warnings;
}
