import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '../providers/types.js';
export type Log = (message: string) => void;
export class UsageTracker {
  readonly totals: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private readonly path: string;
  constructor(root: string) { this.path = resolve(root, `.state/logs/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`); }
  async add(stage: string, model: string, usage?: TokenUsage): Promise<void> {
    if (usage) { this.totals.inputTokens += usage.inputTokens; this.totals.outputTokens += usage.outputTokens; }
    await mkdir(resolve(this.path, '..'), { recursive: true });
    await appendFile(this.path, JSON.stringify({ at: new Date().toISOString(), stage, model, usage: usage ?? null }) + '\n', { mode: 0o600 });
  }
}
