import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile, env } from 'node:process';
import { runTranslation } from './core/translator.js';
import { loadConfig } from './config.js';
import { OpenAIProvider } from './providers/openai.js';
import { missing } from './storage/file-manager.js';

export function parseOptions(args: string[]): { file?: string; force: boolean; dryRun: boolean; help: boolean } {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    file: { type: 'string' }, force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } });
  if (values.file !== undefined && (!values.file || basename(values.file) !== values.file || values.file.includes('\\') || !values.file.toLowerCase().endsWith('.txt'))) {
    throw new Error('--file must be a TXT filename inside raw/, for example chapter-001.txt');
  }
  return { file: values.file, force: values.force ?? false, dryRun: values['dry-run'] ?? false, help: values.help ?? false };
}
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run translate -- [--file chapter-001.txt] [--force] [--dry-run]\nAutomatic checkpoint resume is enabled by default.\n--force bypasses completed output, checkpoints and translation cache.\n--dry-run never calls the API or modifies files.');
    return;
  }
  try { loadEnvFile(); } catch (e) { if (!missing(e)) throw new Error('Could not load environment configuration'); }
  const root = process.cwd(), config = await loadConfig(root);
  const controller = new AbortController();
  const interrupt = () => { controller.abort(new Error('Interrupted; run the same command to resume')); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await runTranslation({ root, config, ...options, signal: controller.signal, providerFactory: () => {
      const apiKey = env['OPENAI_API_KEY']?.trim();
      if (!apiKey || apiKey === 'your_api_key') throw new Error('Missing OPENAI_API_KEY; configure it using .env.example');
      return new OpenAIProvider(apiKey, config.timeoutMs);
    } });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Do not print a stack, request, server response body, or credentials.
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown failure'}`);
    process.exitCode = 1;
  });
}
