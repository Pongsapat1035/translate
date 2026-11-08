import { z } from 'zod';
import { ProviderError } from './types.js';
import type { AIMessage, AIProvider, AIResponse, GenerationOptions } from './types.js';
const responseSchema = z.object({
  status: z.string(),
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })).default([]),
  usage: z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative() }).nullish(),
});
export class OpenAIProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch) {}
  async generate(messages: AIMessage[], options: GenerationOptions): Promise<AIResponse> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])]);
    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/responses', {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model, input: messages, store: false,
          max_output_tokens: options.maxOutputTokens,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          text: { format: { type: 'json_schema', name: options.schemaName, strict: true, schema: options.schema } },
        }),
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new ProviderError(signal.aborted ? 'OpenAI request timed out' : 'OpenAI network request failed', true);
    }
    if (!response.ok) {
      const header = response.headers.get('retry-after');
      const wait = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
      // Never log server error bodies; they can contain user data or credentials.
      await response.body?.cancel();
      throw new ProviderError(`OpenAI HTTP ${response.status}${response.status === 401 ? ': check OPENAI_API_KEY' : ''}`,
        response.status === 429 || response.status === 408 || response.status >= 500, Math.max(0, wait || 0));
    }
    let parsed;
    try { parsed = responseSchema.parse(await response.json()); }
    catch {
      options.signal?.throwIfAborted();
      throw new ProviderError('Malformed OpenAI response or interrupted response body', true);
    }
    const usage = parsed.usage ? { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens } : undefined;
    const contents = parsed.output.flatMap(o => o.content ?? []);
    if (contents.some(c => c.type === 'refusal')) throw new ProviderError('OpenAI declined this request', false, 0, usage);
    if (parsed.status !== 'completed') throw new ProviderError('Incomplete OpenAI response; reduce chunkSizeTokens or increase maxOutputTokens if this repeats', true, 0, usage);
    const text = contents.filter(c => c.type === 'output_text').map(c => c.text ?? '').join('');
    if (!text.trim()) throw new ProviderError('OpenAI returned empty content', true, 0, usage);
    return { text, usage };
  }
}
