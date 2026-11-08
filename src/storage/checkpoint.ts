import { z } from 'zod';
import { resolve } from 'node:path';
import { chapterKey, readJson, readOptional } from './file-manager.js';
import { extractionSchema, glossaryUseSchema } from '../glossary/glossary-manager.js';
import { translationSchema } from '../core/quality-check.js';
import { memorySchema } from '../core/context-manager.js';
export const chunkStateSchema = z.strictObject({
  sourceHash: z.string(), extraction: extractionSchema.optional(),
  translation: z.strictObject({
    result: translationSchema, glossaryUsed: glossaryUseSchema,
    contextHash: z.string(), warnings: z.array(z.string()),
  }).optional(),
  memory: memorySchema.optional(),
});
export type ChunkState = z.infer<typeof chunkStateSchema>;
export const checkpointSchema = z.strictObject({
  version: z.literal(1), fingerprint: z.string(), sourceHash: z.string(),
  configHash: z.string(), dependencyHash: z.string(),
  chunks: z.record(z.string(), chunkStateSchema),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
export const manifestSchema = z.strictObject({
  version: z.literal(1), status: z.literal('complete'), chapter: z.string(), revision: z.string(),
  sourceHash: z.string(), configHash: z.string(), dependencyHash: z.string(),
  outputHash: z.string(), glossaryUsed: glossaryUseSchema,
  glossaryVersion: z.string(), contextVersion: z.string(),
  chunks: z.array(z.strictObject({ id: z.string(), sourceHash: z.string() })),
  warnings: z.array(z.string()), memory: memorySchema,
});
export type Manifest = z.infer<typeof manifestSchema>;
export const checkpointPath = (name: string): string => `.state/checkpoints/${chapterKey(name)}.json`;
export const manifestPath = (name: string): string => `.state/manifests/${chapterKey(name)}.json`;
export async function loadManifest(root: string, name: string): Promise<Manifest | undefined> {
  if (await readOptional(resolve(root, manifestPath(name))) === undefined) return undefined;
  return readJson(resolve(root, manifestPath(name)), manifestSchema);
}
