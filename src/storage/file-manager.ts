import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { z } from 'zod';

export const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}
export function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}
export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (e) { if (missing(e)) return undefined; throw e; }
}
export async function readJson<T>(path: string, schema: z.ZodType<T>, fallback?: T): Promise<T> {
  const text = await readOptional(path);
  if (text === undefined && fallback !== undefined) return structuredClone(fallback);
  try { return schema.parse(JSON.parse(text ?? '')); }
  catch { throw new Error(`Invalid or missing JSON: ${path}`); }
}
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Refuse symlink targets so input files cannot be overwritten via an output alias.
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`); }
  catch (e) { if (!missing(e)) throw e; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (e) { await unlink(temporary).catch(() => {}); throw e; }
}
export interface SourceFile { name: string; text: string; sourceHash: string }
export async function discoverFiles(root: string): Promise<SourceFile[]> {
  const directory = resolve(root, 'raw');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (e) { if (missing(e)) return []; throw e; }
  const names = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
    .map(e => e.name).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }) || a.localeCompare(b));
  return Promise.all(names.map(async name => {
    const bytes = await readFile(resolve(directory, name));
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${name}: unsupported encoding; convert the source to UTF-8`); }
    if (text.includes('\0')) throw new Error(`${name}: binary or UTF-16 input; use UTF-8`);
    return { name, text, sourceHash: hash(text) };
  }));
}
const journalSchema = z.array(z.strictObject({
  path: z.string().refine(p => /^(context\/[^/]+|output\/[^/]+|\.state\/(checkpoints|manifests|memory)\/[^/]+|\.state\/glossary-snapshot\.json)$/.test(p) && !p.split('/').includes('..') && !p.includes('\\')),
  content: z.string(),
}));
export type Write = z.infer<typeof journalSchema>[number];
export class FileStore {
  constructor(readonly root: string) {}
  async recover(): Promise<void> {
    const path = resolve(this.root, '.state/transaction.json');
    const text = await readOptional(path);
    if (text === undefined) return;
    const writes = journalSchema.parse(JSON.parse(text));
    for (const write of writes) await atomicWrite(resolve(this.root, write.path), write.content);
    await unlink(path);
  }
  async commit(writes: Write[]): Promise<void> {
    journalSchema.parse(writes);
    // A roll-forward journal makes multi-file updates idempotent after a crash.
    if (await readOptional(resolve(this.root, '.state/transaction.json')) !== undefined) {
      throw new Error('Unfinished transaction; restart to recover before writing more state');
    }
    await atomicWrite(resolve(this.root, '.state/transaction.json'), json(writes));
    await this.recover();
  }
}
export async function acquireLock(root: string): Promise<() => Promise<void>> {
  const path = resolve(root, '.state/run.lock');
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { await unlink(path).catch(e => { if (!missing(e)) throw e; }); };
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
      const pid = Number(await readOptional(path));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid lock ${path}; ensure no translator is running before removing it`);
      try { process.kill(pid, 0); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          await unlink(path).catch(unlinkError => { if (!missing(unlinkError)) throw unlinkError; });
          continue;
        }
        throw error;
      }
      throw new Error(`Translator already running (PID ${pid})`);
    }
  }
  throw new Error('Could not acquire translator lock; retry');
}
export function chapterKey(name: string): string { return hash(basename(name)); }
