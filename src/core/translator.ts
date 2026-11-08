import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, lstat, readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import { loadConfig, configFingerprint } from '../config.js';
import { FileStore, readJson, readOptional, discoverFiles, hash, json, acquireLock, missing } from '../storage/file-manager.js';
import type { SourceFile, Write } from '../storage/file-manager.js';
import { glossarySchema, reviewSchema, historySchema, glossaryUse, relevantGlossary, compatibleGlossary,
  mergeTerms, glossaryWrites, recordManualCorrections, extractionSchema } from '../glossary/glossary-manager.js';
import type { Glossary, History, Reviews, GlossaryUse } from '../glossary/glossary-manager.js';
import { checkpointSchema, checkpointPath, loadManifest, manifestPath } from '../storage/checkpoint.js';
import type { Checkpoint, Manifest } from '../storage/checkpoint.js';
import { TokenCounter, chunkDocument, renderDocument } from './chunker.js';
import { translationSchema, validateTranslation } from './quality-check.js';
import { boundedContext, combineMemory, emptyMemory, memorySchema } from './context-manager.js';
import type { Memory } from './context-manager.js';
import { extractionPrompt, translationPrompt, memoryPrompt } from './prompt-builder.js';
import { cachedTranslation, cacheTranslation, translationKey } from './translation-memory.js';
import { Generator } from './generator.js';
import { UsageTracker } from '../utils/logger.js';
import type { Log } from '../utils/logger.js';
import type { AIProvider, TokenUsage } from '../providers/types.js';

export interface CLIOptions { file?: string; force?: boolean; dryRun?: boolean }
export interface RunOptions extends CLIOptions {
  root: string; config?: Config; providerFactory: () => AIProvider; log?: Log; signal?: AbortSignal;
}
export interface RunResult { completed: number; skipped: number; failed: number; newTerms: number; usage: TokenUsage }
export interface ChapterPlan {
  source: SourceFile; manifest?: Manifest; dependencyHash: string;
  status: 'valid' | 'pending' | 'empty'; reason: string;
}
export async function assessChapters(root: string, sources: SourceFile[], configHash: string,
  glossary: Glossary, story: boolean, forced = new Set<string>()): Promise<ChapterPlan[]> {
  const chain: string[] = [];
  const plans: ChapterPlan[] = [];
  for (const source of sources) {
    const dependencyHash = hash(story ? chain : []);
    const manifest = await loadManifest(root, source.name);
    if (!source.text.trim()) {
      plans.push({ source, manifest, dependencyHash, status: 'empty', reason: 'empty input' });
      chain.push(hash({ empty: source.name, sourceHash: source.sourceHash }));
      continue;
    }
    let reason = '';
    if (forced.has(source.name)) reason = 'forced';
    else if (!manifest) reason = 'new chapter';
    else if (manifest.sourceHash !== source.sourceHash) reason = 'source changed';
    else if (manifest.configHash !== configHash) reason = 'model, style or translation settings changed';
    else if (manifest.dependencyHash !== dependencyHash) reason = 'earlier narrative context changed or is pending';
    else if (!compatibleGlossary(manifest.glossaryUsed, glossary)) reason = 'used terminology changed';
    else {
      const output = await readOptional(resolve(root, 'output', source.name));
      if (output === undefined || hash(output) !== manifest.outputHash) reason = 'output missing or modified';
    }
    const status = reason ? 'pending' as const : 'valid' as const;
    plans.push({ source, manifest, dependencyHash, status, reason: reason || 'unchanged' });
    chain.push(status === 'valid' && manifest ? manifest.revision : hash({ pending: source.name, sourceHash: source.sourceHash, configHash, dependencyHash, reason }));
  }
  return plans;
}
function contextWrites(plans: ChapterPlan[]): Write[] {
  const valid = plans.flatMap(p => p.status === 'valid' && p.manifest ? [p.manifest] : []);
  return [
    { path: 'context/story-memory.json', content: json({ origin: 'model',
      chapters: valid.map(m => ({ chapter: m.chapter, revision: m.revision, memory: m.memory })),
      staleChapters: plans.filter(p => p.status !== 'valid' && p.manifest).map(p => p.source.name) }) },
    { path: 'context/characters.json', content: json(combineMemory(valid.map(m => m.memory)).characters) },
  ];
}
async function prepareDirectories(root: string): Promise<void> {
  for (const directory of ['raw', 'output', 'context', '.state', '.state/checkpoints', '.state/manifests', '.state/memory', '.state/logs']) {
    const path = resolve(root, directory);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a real directory, not a symlink: ${path}`);
    } catch (e) { if (missing(e)) await mkdir(path); else throw e; }
  }
}
export async function runTranslation(options: RunOptions): Promise<RunResult> {
  const root = resolve(options.root), log = options.log ?? console.log;
  const config = options.config ?? await loadConfig(root);
  const style = await readOptional(resolve(root, 'context/style-guide.md')) ?? 'Use fluent literary language. Preserve meaning, dialogue, character voices and paragraph structure. Do not omit or invent content.';
  const configHash = configFingerprint(config, style);
  const totals: RunResult = { completed: 0, skipped: 0, failed: 0, newTerms: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  const usage = new UsageTracker(root);
  let release: (() => Promise<void>) | undefined;
  try {
    if (!options.dryRun) {
      await prepareDirectories(root);
      release = await acquireLock(root);
      await new FileStore(root).recover();
    } else if (await readOptional(resolve(root, '.state/transaction.json')) !== undefined) {
      throw new Error('An interrupted state transaction needs recovery; run without --dry-run first (recovery itself does not call the API)');
    }
    const sources = await discoverFiles(root);
    if (options.file && !sources.some(s => s.name === options.file)) throw new Error(`Source file not found in raw/: ${options.file}`);
    let glossary = await readJson(resolve(root, 'context/glossary.json'), glossarySchema, {});
    let reviews = await readJson(resolve(root, 'context/glossary-review.json'), reviewSchema, []);
    const historyText = await readOptional(resolve(root, 'context/glossary-history.jsonl')) ?? '';
    let history: History;
    try { history = historyText.split('\n').filter(Boolean).map(line => historySchema.parse(JSON.parse(line))); }
    catch { throw new Error('Invalid context/glossary-history.jsonl'); }
    const targets = sources.filter(s => !options.file || s.name === options.file);
    const forced = new Set(options.force ? targets.map(s => s.name) : []);
    let plans = await assessChapters(root, sources, configHash, glossary, config.enableStoryContext, forced);
    log(`Novel Translator\nProvider: ${config.provider}\nModel: ${config.model}\nLanguage: ${config.sourceLanguage} → ${config.targetLanguage}\nFound ${sources.length} chapters`);
    if (options.dryRun) {
      for (const p of plans) log(`${!options.file || p.source.name === options.file ? '[selected]' : '[context]'} ${p.source.name}: ${p.status} (${p.reason})`);
      log('Dry run: no API calls or file changes.');
      totals.skipped = targets.filter(s => plans.find(p => p.source.name === s.name)?.status !== 'pending').length;
      return totals;
    }
    const store = new FileStore(root);
    const snapshot = await readJson(resolve(root, '.state/glossary-snapshot.json'), glossarySchema, {});
    history = recordManualCorrections(snapshot, glossary, history, sources);
    await store.commit([...glossaryWrites(glossary, reviews, history), ...contextWrites(plans)]);
    if (sources.length === 0) { log('Place UTF-8 .txt files in raw/ and run again.'); return totals; }
    const counter = new TokenCounter(config.tokenEncoding);
    let generator: Generator | undefined;
    for (const [index, source] of targets.entries()) {
      options.signal?.throwIfAborted();
      plans = await assessChapters(root, sources, configHash, glossary, config.enableStoryContext, forced);
      const plan = plans.find(p => p.source.name === source.name);
      if (!plan) throw new Error(`Chapter disappeared: ${source.name}`);
      log(`\n[${index + 1}/${targets.length}] ${source.name}`);
      if (plan.status !== 'pending') { totals.skipped++; log(`  Skipped: ${plan.reason}`); continue; }
      const before = plans.slice(0, plans.indexOf(plan));
      if (config.enableStoryContext && before.some(p => p.status === 'pending')) {
        throw new Error(`${source.name}: earlier chapters need translation first; run npm run translate without --file`);
      }
      generator ??= new Generator(options.providerFactory(), config, counter, usage, log, options.signal);
      const prior = before.flatMap(p => p.status === 'valid' && p.manifest ? [{ chapter: p.source.name, memory: p.manifest.memory }] : []);
      const result = await translateChapter({ root, source, sources, config, configHash, style, plan, prior,
        glossary, reviews, history, store, counter, generator, log, force: forced.has(source.name), signal: options.signal });
      glossary = result.glossary; reviews = result.reviews; history = result.history;
      totals.newTerms += result.added;
      totals.completed++;
      forced.delete(source.name);
      plans = await assessChapters(root, sources, configHash, glossary, config.enableStoryContext, forced);
      await store.commit(contextWrites(plans));
      log(`  Saved: output/${source.name}`);
    }
    totals.usage = usage.totals;
    log(`\nTranslation finished.\nCompleted: ${totals.completed}\nSkipped: ${totals.skipped}\nFailed: ${totals.failed}\nNew glossary terms: ${totals.newTerms}`);
    log(`Tokens (reported): input ${usage.totals.inputTokens}, output ${usage.totals.outputTokens}`);
    if (config.pricing) {
      const cost = (usage.totals.inputTokens * config.pricing.inputPerMillion + usage.totals.outputTokens * config.pricing.outputPerMillion) / 1e6;
      log(`Estimated cost for reported usage: ${cost.toFixed(6)} ${config.pricing.currency} (configured prices)`);
    }
    return totals;
  } catch (e) {
    totals.failed = 1;
    log(`Stopped. Completed: ${totals.completed}; skipped: ${totals.skipped}; failed: ${totals.failed}.`);
    log(`Tokens (reported): input ${usage.totals.inputTokens}, output ${usage.totals.outputTokens}`);
    log('Completed output and saved checkpoints are preserved. Run again to resume.');
    throw e;
  } finally { await release?.(); }
}
interface ChapterOptions {
  root: string; source: SourceFile; sources: SourceFile[]; config: Config; configHash: string; style: string;
  plan: ChapterPlan; prior: { chapter: string; memory: Memory }[];
  glossary: Glossary; reviews: Reviews; history: History; store: FileStore; counter: TokenCounter;
  generator: Generator; log: Log; force: boolean; signal?: AbortSignal;
}
async function translateChapter(o: ChapterOptions): Promise<{ glossary: Glossary; reviews: Reviews; history: History; added: number }> {
  const { root, source, config, counter, store, generator, log } = o;
  const document = chunkDocument(source.text, config.chunkSizeTokens, counter);
  const fingerprint = hash({ sourceHash: source.sourceHash, configHash: o.configHash, dependencyHash: o.plan.dependencyHash });
  let checkpoint: Checkpoint = { version: 1, fingerprint, sourceHash: source.sourceHash,
    configHash: o.configHash, dependencyHash: o.plan.dependencyHash, chunks: {} };
  if (config.enableResume && !o.force) {
    const saved = await readJson(resolve(root, checkpointPath(source.name)), checkpointSchema, checkpoint);
    if (saved.fingerprint === fingerprint) checkpoint = saved;
  }
  const checkpointWrite = (): Write => ({ path: checkpointPath(source.name), content: json(checkpoint) });
  let { glossary, reviews, history } = o;
  let added = 0, previous = '';
  const memories: Memory[] = [], translations = new Map<string, string>(), used: GlossaryUse = {};
  const warnings: string[] = [];
  for (const [index, chunk] of document.chunks.entries()) {
    o.signal?.throwIfAborted();
    log(`  Chunk ${index + 1}/${document.chunks.length}`);
    let state = checkpoint.chunks[chunk.id];
    if (!state || state.sourceHash !== chunk.sourceHash) {
      state = { sourceHash: chunk.sourceHash };
      checkpoint.chunks[chunk.id] = state;
    }
    const local = memories.length ? [{ chapter: source.name, memory: combineMemory(memories) }] : [];
    const context = config.enableStoryContext ? boundedContext([...o.prior, ...local], counter, config.contextMaxTokens) : '{}';
    const contextHash = hash({ context, previous });
    if (state.translation && (!compatibleGlossary(state.translation.glossaryUsed, glossary) || state.translation.contextHash !== contextHash)) {
      delete state.translation; delete state.memory;
    }
    if (!state.translation && config.enableDynamicGlossary && config.enableTerminologyExtraction) {
      if (!state.extraction) {
        log('  Extracting terminology...');
        state.extraction = await generator.generate('terminology', extractionSchema,
          extractionPrompt(chunk, relevantGlossary(glossary, chunk.fragments.map(f => f.text).join('\n')), context, config));
        // Reject hallucinated source terms even if they occur elsewhere in the chapter.
        const chunkText = chunk.fragments.map(f => f.text).join('\n');
        state.extraction.terms = state.extraction.terms.filter(t => chunkText.includes(t.source));
      }
      const merged = mergeTerms(glossary, reviews, history, state.extraction, source, o.sources);
      glossary = merged.glossary; reviews = merged.reviews; history = merged.history; added += merged.added;
      await store.commit([...glossaryWrites(glossary, reviews, history), checkpointWrite()]);
      log(`  New terms: ${merged.added}`);
    }
    const relevant = relevantGlossary(glossary, chunk.fragments.map(f => f.text).join('\n'));
    if (!state.translation) {
      const messages = translationPrompt(chunk, relevant, context, previous, o.style, config);
      const cacheKey = translationKey(chunk.sourceHash, o.configHash, messages, config);
      let translated = config.enableTranslationMemory && !o.force ? await cachedTranslation(root, cacheKey, chunk.sourceHash) : undefined;
      if (translated) validateTranslation(chunk, translated, relevant, config.enableQualityCheck);
      else {
        log('  Translating...');
        translated = await generator.generate('translation', translationSchema, messages,
          result => { validateTranslation(chunk, result, relevant, config.enableQualityCheck); });
      }
      const qa = validateTranslation(chunk, translated, relevant, config.enableQualityCheck);
      state.translation = { result: translated, glossaryUsed: glossaryUse(relevant), contextHash, warnings: qa };
      // Persist a successful translation before any optional narrative-memory API call.
      await store.commit([checkpointWrite()]);
      if (config.enableTranslationMemory) await cacheTranslation(root, cacheKey, chunk.sourceHash, translated);
    } else log('  Resumed validated chunk.');
    const qa = validateTranslation(chunk, state.translation.result, relevant, config.enableQualityCheck);
    warnings.push(...qa);
    for (const warning of qa) log(`  Warning: ${warning}`);
    Object.assign(used, state.translation.glossaryUsed);
    for (const p of state.translation.result.paragraphs) translations.set(p.id, p.text);
    if (config.enableStoryContext) {
      if (!state.memory) {
        log('  Recording provisional story notes...');
        state.memory = await generator.generate('story_memory', memorySchema, memoryPrompt(chunk, state.translation.result, context, config));
        await store.commit([checkpointWrite()]);
      }
      memories.push(state.memory);
    }
    previous = counter.tail(previous + '\n' + state.translation.result.paragraphs.map(p => p.text).join('\n'), config.previousTextTokens);
  }
  if (translations.size !== document.chunks.reduce((n, c) => n + c.fragments.length, 0)) throw new Error('Missing translated chunks');
  const output = renderDocument(document, translations);
  const currentSource = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolve(root, 'raw', source.name)));
  if (hash(currentSource) !== source.sourceHash) throw new Error(`${source.name}: source changed while translating; rerun to rebuild its checkpoints`);
  const manifest: Manifest = { version: 1, status: 'complete', chapter: source.name, revision: randomUUID(),
    sourceHash: source.sourceHash, configHash: o.configHash, dependencyHash: o.plan.dependencyHash,
    outputHash: hash(output), glossaryUsed: used, glossaryVersion: hash(glossary), contextVersion: hash(o.prior),
    chunks: document.chunks.map(c => ({ id: c.id, sourceHash: c.sourceHash })), warnings,
    memory: config.enableStoryContext ? combineMemory(memories) : emptyMemory() };
  // No output is replaced until every chunk and all required memory requests succeed.
  const finalPlans = await assessChapters(root, o.sources, o.configHash, glossary, config.enableStoryContext);
  const currentIndex = finalPlans.findIndex(p => p.source.name === source.name);
  const updatedPlans = finalPlans.map((p, index) => {
    if (index === currentIndex) return { ...p, status: 'valid' as const, reason: 'complete', manifest };
    if (config.enableStoryContext && index > currentIndex && p.status !== 'empty') {
      return { ...p, status: 'pending' as const, reason: 'earlier narrative context changed' };
    }
    return p;
  });
  await store.commit([
    { path: `output/${source.name}`, content: output },
    { path: manifestPath(source.name), content: json(manifest) },
    ...contextWrites(updatedPlans),
  ]);
  return { glossary, reviews, history, added };
}
