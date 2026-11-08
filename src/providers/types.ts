export interface AIMessage { role: 'system' | 'user'; content: string }
export interface GenerationOptions {
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  schema: Record<string, unknown>;
  schemaName: string;
  signal?: AbortSignal;
}
export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface AIResponse { text: string; usage?: TokenUsage }
export interface AIProvider {
  generate(messages: AIMessage[], options: GenerationOptions): Promise<AIResponse>;
}
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0,
    readonly usage?: TokenUsage) { super(message); }
}
