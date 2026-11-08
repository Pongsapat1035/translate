import { z } from 'zod';
import type { TokenCounter } from './chunker.js';
const factSchema = z.strictObject({ text: z.string().min(1).max(500), evidence: z.enum(['explicit', 'inferred']) });
export const characterSchema = z.strictObject({
  name: z.string().min(1).max(200), aliases: z.array(z.string().max(200)).max(10),
  role: z.string().max(500), relationships: z.array(factSchema).max(10),
  traits: z.array(factSchema).max(10), identity: z.string().max(500),
  evidence: z.enum(['explicit', 'inferred']),
});
export const memorySchema = z.strictObject({
  summary: z.string().max(2000), events: z.array(factSchema).max(12),
  locations: z.array(z.string().max(200)).max(15), relationships: z.array(factSchema).max(12),
  unresolved: z.array(factSchema).max(12), characters: z.array(characterSchema).max(20),
});
export type Memory = z.infer<typeof memorySchema>;
export const emptyMemory = (): Memory => ({ summary: '', events: [], locations: [], relationships: [], unresolved: [], characters: [] });
export function combineMemory(parts: Memory[]): Memory {
  const characters = new Map<string, Memory['characters'][number]>();
  for (const part of parts) for (const c of part.characters) {
    const previous = characters.get(c.name);
    characters.set(c.name, previous ? { ...c,
      aliases: [...new Set([...previous.aliases, ...c.aliases])].slice(-10),
      relationships: [...previous.relationships, ...c.relationships].slice(-10),
      traits: [...previous.traits, ...c.traits].slice(-10),
      role: c.role || previous.role, identity: c.identity || previous.identity,
    } : c);
  }
  return {
    summary: parts.map(p => p.summary).filter(Boolean).join('\n').slice(-2000),
    events: parts.flatMap(p => p.events).slice(-12), locations: [...new Set(parts.flatMap(p => p.locations))].slice(-15),
    relationships: parts.flatMap(p => p.relationships).slice(-12), unresolved: parts.flatMap(p => p.unresolved).slice(-12),
    characters: [...characters.values()].slice(-20),
  };
}
export function boundedContext(parts: { chapter: string; memory: Memory }[], counter: TokenCounter, budget: number): string {
  const recent = parts.slice(-5);
  const memory = combineMemory(parts.map(p => p.memory));
  const context = { origin: 'model-generated; evidence labels are model judgments, not independently verified',
    recentChapters: recent.map(p => ({ chapter: p.chapter, summary: p.memory.summary })), memory };
  while (counter.count(JSON.stringify(context)) > budget) {
    if (context.recentChapters.length) context.recentChapters.shift();
    else if (memory.characters.length) memory.characters.shift();
    else if (memory.events.length) memory.events.shift();
    else if (memory.relationships.length) memory.relationships.shift();
    else if (memory.unresolved.length) memory.unresolved.shift();
    else if (memory.locations.length) memory.locations.shift();
    else if (memory.summary.length) memory.summary = memory.summary.slice(Math.ceil(memory.summary.length / 3));
    else return '{}';
  }
  return JSON.stringify(context);
}
