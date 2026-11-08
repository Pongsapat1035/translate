import { z } from 'zod';
import { resolve } from 'node:path';
import { hash, readJson, readOptional, atomicWrite, json } from '../storage/file-manager.js';
import { translationSchema } from './quality-check.js';
import type { Translation } from './quality-check.js';
import type { AIMessage } from '../providers/types.js';
import type { Config } from '../config.js';
const cacheSchema = z.strictObject({ key: z.string(), sourceHash: z.string(), result: translationSchema });
export function translationKey(sourceHash: string, configHash: string, messages: AIMessage[], config: Config): string {
  // The full bounded prompt includes narrative position and prior translated prose.
  // Exact matches in different narrative contexts therefore never collide.
  return hash({ sourceHash, configHash, messages, model: config.model, version: 1 });
}
export async function cachedTranslation(root: string, key: string, sourceHash: string): Promise<Translation | undefined> {
  const path = resolve(root, `.state/memory/${key}.json`);
  const text = await readOptional(path);
  if (text === undefined) return undefined;
  const cached = await readJson(path, cacheSchema);
  return cached.key === key && cached.sourceHash === sourceHash ? cached.result : undefined;
}
export async function cacheTranslation(root: string, key: string, sourceHash: string, result: Translation): Promise<void> {
  await atomicWrite(resolve(root, `.state/memory/${key}.json`), json({ key, sourceHash, result }));
}
