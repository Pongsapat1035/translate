import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { AIMessage, AIProvider } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import type { TokenCounter } from './chunker.js';
import { retry } from '../utils/retry.js';
import type { UsageTracker, Log } from '../utils/logger.js';
export class Generator {
  private lastRequest = 0;
  constructor(private provider: AIProvider, private config: Config, private counter: TokenCounter,
    private usage: UsageTracker, private log: Log, private signal?: AbortSignal) {}
  async generate<T>(name: string, schema: z.ZodType<T>, messages: AIMessage[], validate?: (data: T) => void): Promise<T> {
    const jsonSchema = z.toJSONSchema(schema);
    const inputEstimate = Math.ceil((messages.reduce((n, m) => n + this.counter.count(m.content) + 32, 0)
      + this.counter.count(JSON.stringify(jsonSchema))) * 1.1);
    if (inputEstimate + this.config.maxOutputTokens + this.config.safetyMarginTokens > this.config.contextWindowTokens) {
      throw new Error(`${name}: prompt exceeds configured context budget; reduce chunkSizeTokens, contextMaxTokens or previousTextTokens, or configure the model context limit`);
    }
    return retry(async () => {
      const wait = this.config.minRequestIntervalMs - (Date.now() - this.lastRequest);
      if (wait > 0) await setTimeout(wait, undefined, { signal: this.signal });
      this.lastRequest = Date.now();
      const response = await this.provider.generate(messages, {
        model: this.config.model, maxOutputTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature, schema: jsonSchema, schemaName: name, signal: this.signal,
      }).catch(async (error: unknown) => {
        await this.usage.add(`${name}:failed`, this.config.model, error instanceof ProviderError ? error.usage : undefined);
        throw error;
      });
      await this.usage.add(name, this.config.model, response.usage);
      let data: T;
      try { data = schema.parse(JSON.parse(response.text)); }
      catch { throw new ProviderError(`${name}: malformed structured output`, true); }
      validate?.(data);
      return data;
    }, { ...this.config, signal: this.signal, onRetry: (attempt, ms) => this.log(`  Retrying ${name} (${attempt}/${this.config.maxRetries}) in ${ms}ms`) });
  }
}
