import { resolve } from 'node:path';
import { z } from 'zod';
import { readJson, hash } from './storage/file-manager.js';

export const configSchema = z.strictObject({
  sourceLanguage: z.string().min(1).default('zh'),
  targetLanguage: z.string().min(1).default('th'),
  provider: z.literal('openai').default('openai'),
  model: z.string().min(1).default('gpt-4.1'),
  tokenEncoding: z.enum(['o200k_base', 'cl100k_base']).default('o200k_base'),
  contextWindowTokens: z.number().int().min(2048).default(32768),
  chunkSizeTokens: z.number().int().min(32).default(1500),
  maxOutputTokens: z.number().int().min(128).default(8192),
  contextMaxTokens: z.number().int().min(128).default(3000),
  previousTextTokens: z.number().int().nonnegative().default(500),
  safetyMarginTokens: z.number().int().min(128).default(1024),
  concurrency: z.literal(1).default(1),
  translationStyle: z.string().min(1).default('literary'),
  temperature: z.number().min(0).max(2).optional(),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryBaseMs: z.number().int().min(1).default(1000),
  timeoutMs: z.number().int().positive().default(120000),
  minRequestIntervalMs: z.number().int().nonnegative().default(500),
  enableDynamicGlossary: z.boolean().default(true),
  enableTerminologyExtraction: z.boolean().default(true),
  enableStoryContext: z.boolean().default(true),
  enableTranslationMemory: z.boolean().default(true),
  enableResume: z.boolean().default(true),
  enableQualityCheck: z.boolean().default(true),
  pricing: z.strictObject({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    currency: z.string().min(1).default('USD'),
  }).optional(),
}).superRefine((c, ctx) => {
  if (c.chunkSizeTokens + c.maxOutputTokens + c.safetyMarginTokens >= c.contextWindowTokens) {
    ctx.addIssue({ code: 'custom', message: 'chunkSizeTokens + maxOutputTokens + safetyMarginTokens must be smaller than contextWindowTokens' });
  }
});
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(root: string): Promise<Config> {
  return readJson(resolve(root, 'config.json'), configSchema, configSchema.parse({}));
}
export function configFingerprint(config: Config, style: string): string {
  const { maxRetries, retryBaseMs, timeoutMs, minRequestIntervalMs, pricing,
    enableResume, enableTranslationMemory, ...translation } = config;
  // Operational settings do not change the translation contract.
  return hash({ version: 1, translation, style });
}
