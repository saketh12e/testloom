import {
  opendir,
  readFile,
  stat,
  lstat,
  mkdir,
  copyFile,
  writeFile,
  realpath,
  open,
  rename,
  rm,
  chmod,
} from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Project, GeneratedFile } from '../shared/types';

const OMIT = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'target',
  '.gradle',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
  '.yarn',
  '.pnpm-store',
  '.npm',
  '.idea',
  '.vscode',
  '.next',
  '.venv',
  'venv',
  'coverage',
  'test-results',
  'playwright-report',
  '.journeyproof',
  '.testloom',
  '.codex',
  '.claude',
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.DS_Store',
]);
export function excluded(name: string): boolean {
  return (
    OMIT.has(name) ||
    /^\.env(?:\.|$)/.test(name) ||
    /(?:\.pem|\.key|\.p12|\.pfx|credentials\.json|auth\.json)$/i.test(name)
  );
}
export function scrubText(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat|glpat)[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(
      /(["'](?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /((?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)["']?[^\s"',;]+["']?/gi,
      '$1"[REDACTED]"',
    );
}
export async function verifyGeneratedBytes(
  root: string,
  files: GeneratedFile[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const canonical = await realpath(root);
  for (const file of files) {
    const full = path.join(canonical, file.path);
    const actual = await realpath(full);
    if (!actual.startsWith(canonical + path.sep) || (await lstat(full)).isSymbolicLink())
      throw new Error(
        'A generated file now points outside its workspace. Regenerate before verifying.',
      );
    const disk = await readFile(full, 'utf8');
    if (disk !== file.content)
      throw new Error(
        `Generated test changed on disk: ${file.path}. Regenerate before verifying or exporting so the evidence matches the test.`,
      );
    hashes[file.path] = createHash('sha256').update(disk).digest('hex');
  }
  return hashes;
}
/** Counts are discovered files during a scan and completed files during a snapshot. */
export interface RepositoryProgress {
  phase: 'scan' | 'snapshot';
  fileCount: number;
  directoryCount: number;
  bytesCopied: number;
  totalFiles?: number;
  elapsedMs: number;
  done: boolean;
}
export interface RepositoryOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RepositoryProgress) => void;
  concurrency?: number;
  maxFiles?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  progressIntervalMs?: number;
}
const DEFAULTS = {
  concurrency: 16,
  maxFiles: 1_000_000,
  maxDepth: 64,
  maxFileBytes: 2 * 1024 ** 3,
  maxTotalBytes: 50 * 1024 ** 3,
  progressIntervalMs: 500,
};
type Options = RepositoryOptions & typeof DEFAULTS;
type Directory = { relative: string; identity: Stats };
const CHUNK_BYTES = 256 * 1024;
const DIGEST_ALGORITHM = 'sha256-sorted-file-manifest-v1';
const changed = () => new Error('Project changed during scan or snapshot. Please retry.');
function optionsFor(input: RepositoryOptions): Options {
  const options = { ...DEFAULTS, ...input };
  for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    // Explicit undefined has the same meaning as an omitted option.
    options[key] = input[key] ?? DEFAULTS[key];
    if (
      !Number.isSafeInteger(options[key]) ||
      options[key] < (key === 'maxDepth' || key === 'progressIntervalMs' ? 0 : 1)
    )
      throw new Error(`Invalid repository option: ${key}.`);
  }
  if (options.concurrency > 64) throw new Error('Repository concurrency must be between 1 and 64.');
  options.signal?.throwIfAborted();
  return options;
}
function progressReporter(options: Options, phase: RepositoryProgress['phase']) {
  const started = performance.now();
  let last = -Infinity;
  return (
    fileCount: number,
    directoryCount: number,
    bytesCopied = 0,
    totalFiles?: number,
    done = false,
  ) => {
    options.signal?.throwIfAborted();
    const now = performance.now();
    if (options.onProgress && (done || now - last >= options.progressIntervalMs)) {
      last = now;
      options.onProgress({
        phase,
        fileCount,
        directoryCount,
        bytesCopied,
        totalFiles,
        elapsedMs: Math.round(now - started),
        done,
      });
      options.signal?.throwIfAborted();
    }
  };
}
function inside(root: string, candidate: string): boolean {
  return (
    candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  );
}
function sameIdentity(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function checkedDirectory(full: string): Promise<Stats> {
  const info = await lstat(full);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(full)) !== full)
    throw new Error('Project paths cannot traverse symlinks or escape their folder.');
  return info;
}
/** A fixed worker pool: no promise or buffer is allocated per queued file. */
async function forEachConcurrent<T>(
  items: readonly T[],
  options: Options,
  task: (item: T, index: number, worker: number) => Promise<void>,
) {
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, items.length) }, async (_, worker) => {
      while (!failed) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          options.signal?.throwIfAborted();
          await task(items[index], index, worker);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  // All in-flight work has settled before a caller cleans up its workspace.
  if (failed) throw failure;
  options.signal?.throwIfAborted();
}
async function scanProject(input: string, options: Options) {
  const started = performance.now();
  options.signal?.throwIfAborted();
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project folder.');
  const files: string[] = [];
  const directories: Directory[] = [];
  const queue = [{ relative: '', depth: 0 }];
  const active = new Set<Promise<void>>();
  const report = progressReporter(options, 'scan');
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  report(0, 0);
  async function walk(job: (typeof queue)[number]) {
    options.signal?.throwIfAborted();
    const full = path.join(root, job.relative);
    const identity = await checkedDirectory(full);
    const dir = await opendir(full, { bufferSize: 256 });
    // Iteration closes the directory even on abort, overflow, or a callback error.
    for await (const entry of dir) {
      if (failed) return;
      options.signal?.throwIfAborted();
      if (excluded(entry.name) || entry.isSymbolicLink()) continue;
      const relative = path.join(job.relative, entry.name);
      if (entry.isDirectory()) {
        if (job.depth >= options.maxDepth)
          throw new Error(
            `Project exceeds the supported directory depth of ${options.maxDepth}: ${relative}.`,
          );
        if (queue.length >= 1_000_000)
          throw new Error('Project exceeds the supported limit of 1,000,000 source directories.');
        queue.push({ relative, depth: job.depth + 1 });
      } else if (entry.isFile()) {
        if (files.length >= options.maxFiles)
          throw new Error(
            `Project exceeds the supported limit of ${options.maxFiles.toLocaleString('en-US')} source files.`,
          );
        files.push(relative);
        report(files.length, directories.length);
      }
    }
    if (!sameIdentity(identity, await checkedDirectory(full))) throw changed();
    directories.push({ relative: job.relative, identity });
    report(files.length, directories.length);
  }
  // Directories add jobs while running; cap both active I/O and the traversal frontier.
  while ((cursor < queue.length || active.size) && !failed) {
    while (cursor < queue.length && active.size < options.concurrency && !failed) {
      let running: Promise<void>;
      running = walk(queue[cursor++])
        .catch((error) => {
          if (!failed) failure = error;
          failed = true;
        })
        .finally(() => active.delete(running));
      active.add(running);
    }
    if (active.size) await Promise.race(active);
  }
  await Promise.all(active);
  if (failed) throw failure;
  options.signal?.throwIfAborted();
  // Code-unit ordering is stable across OS locales and worker completion orders.
  files.sort();
  report(files.length, directories.length, 0, files.length, true);
  return {
    root,
    files,
    directories,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Math.round(performance.now() - started),
  };
}
export async function listProjectFiles(
  root: string,
  maxFilesOrOptions: number | RepositoryOptions = {},
): Promise<string[]> {
  const options = optionsFor(
    typeof maxFilesOrOptions === 'number' ? { maxFiles: maxFilesOrOptions } : maxFilesOrOptions,
  );
  return (await scanProject(root, options)).files;
}
async function openSource(root: string, relative: string) {
  const full = path.join(root, relative);
  const before = await lstat(full);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (await realpath(full)) !== full ||
    !inside(root, full)
  )
    throw new Error('Project file changed or escaped its folder through a symlink.');
  // NOFOLLOW pins the last component; realpath and directory identity checks cover ancestors.
  // NONBLOCK prevents a racing FIFO replacement from hanging an open operation.
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameIdentity(before, await handle.stat())) throw changed();
    return { handle, before, full };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function checkSource(source: Awaited<ReturnType<typeof openSource>>) {
  if (
    !sameIdentity(source.before, await source.handle.stat()) ||
    !sameIdentity(source.before, await lstat(source.full)) ||
    (await realpath(source.full)) !== source.full
  )
    throw changed();
}
export async function inspectProject(
  input: string,
  inputOptions: RepositoryOptions = {},
): Promise<Project> {
  const options = optionsFor(inputOptions);
  const { root, files, scannedAt, scanDurationMs } = await scanProject(input, options);
  const fileSet = new Set(files);
  const cache = new Map<string, string>();
  const read = async (f: string) => {
    options.signal?.throwIfAborted();
    // Never read unscanned paths (including a symlinked manifest) or entire large examples.
    if (!fileSet.has(f)) return '';
    const cached = cache.get(f);
    if (cached !== undefined) return cached;
    const source = await openSource(root, f);
    try {
      const buffer = Buffer.alloc(Math.min(source.before.size, 40_000));
      let offset = 0;
      while (offset < buffer.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await source.handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!bytesRead) throw changed();
        offset += bytesRead;
      }
      await checkSource(source);
      const content = buffer.toString('utf8');
      cache.set(f, content);
      return content;
    } finally {
      await source.handle.close();
    }
  };
  const pkgText = await read('package.json');
  let pkg: any = {};
  try {
    pkg = JSON.parse(pkgText || '{}');
  } catch {
    throw new Error(
      'The project package.json is not valid JSON or exceeds the 40 KB inspection limit.',
    );
  }
  const javaBuild =
    (await read('pom.xml')) || (await read('build.gradle')) || (await read('build.gradle.kts'));
  const java =
    fileSet.has('pom.xml') || fileSet.has('build.gradle') || fileSet.has('build.gradle.kts');
  const testFiles: string[] = [];
  const helperFiles: string[] = [];
  let playwrightConfig = false;
  // Reuse the one scan; only retain the bounded examples sent to the generator.
  for (const f of files) {
    if (
      testFiles.length < 5 &&
      /(?:\.spec\.[jt]sx?$|\.test\.[jt]sx?$|Test\.java$|src\/test\/.*\.java$)/.test(f)
    )
      testFiles.push(f);
    if (
      helperFiles.length < 4 &&
      /(?:pages?|fixtures?|support|helpers?)\//i.test(f) &&
      /\.(?:java|[jt]s)$/.test(f)
    )
      helperFiles.push(f);
    if (/playwright\.config/.test(f)) playwrightConfig = true;
  }
  const configFiles = [
    'package.json',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'playwright.config.ts',
    'playwright.config.js',
  ].filter((f) => fileSet.has(f));
  const contextFiles = [...new Set([...testFiles, ...helperFiles, ...configFiles])];
  const examples = await Promise.all(
    contextFiles.map(async (f) => ({
      path: f,
      content: scrubText((await read(f)).slice(0, 10_000)),
    })),
  );
  options.signal?.throwIfAborted();
  const clues = javaBuild + pkgText + examples.map((e) => e.content).join('\n');
  const framework = java
    ? /playwright/i.test(clues)
      ? 'playwright-java'
      : /selenium/i.test(clues)
        ? 'selenium-java'
        : 'unknown'
    : /playwright/i.test(clues) || playwrightConfig
      ? 'playwright-ts'
      : 'unknown';
  const buildTool = java
    ? fileSet.has('pom.xml')
      ? 'Maven'
      : 'Gradle'
    : pkgText
      ? 'npm'
      : 'Unconfigured';
  const commands = java
    ? [
        {
          executable: fileSet.has('pom.xml')
            ? fileSet.has('mvnw')
              ? './mvnw'
              : 'mvn'
            : fileSet.has('gradlew')
              ? './gradlew'
              : 'gradle',
          args: ['test'],
          label: `${buildTool} tests`,
        },
      ]
    : pkg.scripts?.test
      ? [{ executable: 'npm', args: ['test'], label: 'Project test script' }]
      : framework === 'playwright-ts'
        ? [
            {
              executable: 'npx',
              args: ['--no-install', 'playwright', 'test'],
              label: 'Playwright tests',
            },
          ]
        : [];
  return {
    id: createHash('sha256').update(root).digest('hex'),
    name: path.basename(root),
    path: root,
    framework,
    buildTool,
    summary: `${files.length} source files · ${testFiles.length} test examples · ${framework === 'unknown' ? 'Framework needs review' : framework.replaceAll('-', ' ')}`,
    examples,
    commands,
    outputDir: java ? 'src/test/java/testloom' : 'tests/testloom',
    repository: { fileCount: files.length, scannedAt, scanDurationMs },
  };
}
/** Resolve even a not-yet-created destination without creating anything inside the source. */
async function snapshotTarget(destination: string, root: string) {
  const requested = path.resolve(destination);
  let ancestor = requested;
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      const target = path.join(canonical, path.relative(ancestor, requested));
      if (inside(root, target))
        throw new Error('The isolated workspace must be outside the connected project.');
      if (ancestor === requested && (await lstat(requested)).isSymbolicLink())
        throw new Error('The isolated workspace cannot be a symlink.');
      return target;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
export async function snapshotProject(
  project: Project,
  destination: string,
  inputOptions: RepositoryOptions = {},
): Promise<{ count: number; digest: string }> {
  const options = optionsFor(inputOptions);
  const root = await realpath(project.path);
  const target = await snapshotTarget(destination, root);
  // An existing empty destination is supported; never merge with or overwrite existing files.
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('The isolated workspace must be an empty directory.');
    const dir = await opendir(target);
    try {
      if (await dir.read()) throw new Error('The isolated workspace must be an empty directory.');
    } finally {
      await dir.close();
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { files, directories } = await scanProject(root, options);
  options.signal?.throwIfAborted();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if ((await realpath(path.dirname(target))) !== path.dirname(target))
    throw new Error('The isolated workspace parent changed or traverses a symlink.');
  const staging = path.join(
    path.dirname(target),
    `.${path.basename(target)}.testloom-${randomUUID()}`,
  );
  await mkdir(staging, { mode: 0o700 });
  const report = progressReporter(options, 'snapshot');
  let total = 0;
  let bytesCopied = 0;
  let count = 0;
  let clonedFiles = 0;
  let cloneAvailable = process.platform === 'darwin' || process.platform === 'linux';
  const fileDigests = new Array<string>(files.length);
  const buffers = Array.from({ length: Math.min(options.concurrency, files.length) }, () =>
    Buffer.allocUnsafe(CHUNK_BYTES),
  );
  const directoryModes: string[] = [];
  try {
    report(0, directories.length, 0, files.length);
    await forEachConcurrent(directories, options, async (dir) => {
      if (dir.relative)
        await mkdir(path.join(staging, dir.relative), { recursive: true, mode: 0o700 });
    });
    await forEachConcurrent(files, options, async (file, index, worker) => {
      const source = await openSource(root, file);
      try {
        options.signal?.throwIfAborted();
        const size = source.before.size;
        if (size > options.maxFileBytes)
          throw new Error(
            `Source file exceeds the ${options.maxFileBytes.toLocaleString('en-US')} byte per-file snapshot limit: ${file}.`,
          );
        total += size; // Reservation occurs synchronously before the first copy await.
        if (total > options.maxTotalBytes)
          throw new Error(
            `Project exceeds the ${options.maxTotalBytes.toLocaleString('en-US')} byte total source snapshot limit.`,
          );
        const output = path.join(staging, file);
        let cloned = false;
        if (cloneAvailable) {
          try {
            // Clone from the pinned descriptor, never reopen a source path that could have changed.
            // FORCE lets unsupported/cross-device filesystems fall back to our abortable stream.
            const descriptor = `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${source.handle.fd}`;
            await copyFile(
              descriptor,
              output,
              constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
            );
            cloned = true;
          } catch (error: any) {
            if (
              !['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'EXDEV', 'ENOTTY', 'ENOENT'].includes(
                error.code,
              )
            )
              throw error;
            cloneAvailable = false;
          }
        }
        options.signal?.throwIfAborted();
        const copied = await open(
          output,
          cloned
            ? constants.O_RDONLY | constants.O_NOFOLLOW
            : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const hash = createHash('sha256');
          const buffer = buffers[worker];
          let position = 0;
          // Fixed-size reusable buffers keep memory proportional to concurrency, never file size.
          // For clones hash the copy; for streams hash only the bytes successfully written.
          while (position < size) {
            options.signal?.throwIfAborted();
            const { bytesRead } = await (cloned ? copied : source.handle).read(
              buffer,
              0,
              Math.min(buffer.length, size - position),
              position,
            );
            if (!bytesRead) throw changed();
            if (!cloned) {
              let written = 0;
              while (written < bytesRead) {
                options.signal?.throwIfAborted();
                const { bytesWritten } = await copied.write(
                  buffer,
                  written,
                  bytesRead - written,
                  position + written,
                );
                if (!bytesWritten) throw new Error(`Unable to finish copying ${file}.`);
                written += bytesWritten;
              }
            }
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
            bytesCopied += bytesRead;
            report(count, directories.length, bytesCopied, files.length);
          }
          if ((await copied.stat()).size !== size) throw changed();
          await checkSource(source);
          const mode = source.before.mode & 0o7777;
          await copied.chmod(mode);
          // JSON framing is unambiguous for all legal names; the manifest includes executable bits.
          fileDigests[index] =
            JSON.stringify([file.split(path.sep).join('/'), mode, size, hash.digest('hex')]) + '\n';
          if (cloned) clonedFiles++;
          count++;
          report(count, directories.length, bytesCopied, files.length);
        } finally {
          await copied.close();
        }
      } finally {
        await source.handle.close();
      }
    });
    // Detect ancestor replacement (including transient renames) and ignored-subtree swaps.
    await forEachConcurrent(directories, options, async (dir) => {
      if (!sameIdentity(dir.identity, await checkedDirectory(path.join(root, dir.relative))))
        throw changed();
    });
    const hash = createHash('sha256').update(DIGEST_ALGORITHM + '\0');
    for (const entry of fileDigests) hash.update(entry);
    const digest = hash.digest('hex');
    await mkdir(path.join(staging, '.journeyproof'), { mode: 0o700 });
    await writeFile(
      path.join(staging, '.journeyproof/provenance.json'),
      JSON.stringify(
        {
          source: root,
          digest,
          digestAlgorithm: DIGEST_ALGORITHM,
          digestEncoding:
            'UTF-8 algorithm + NUL, then sorted JSON [path, mode, size, sha256] + LF per file',
          files: count,
          bytes: total,
          clonedFiles,
          streamedFiles: count - clonedFiles,
          createdAt: new Date().toISOString(),
          excluded: [...OMIT],
          symlinks: 'excluded',
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    // Apply directory modes after their children are written, deepest first.
    const byDepth = new Map<number, Directory[]>();
    for (const dir of directories) {
      const depth = dir.relative ? dir.relative.split(path.sep).length : 0;
      const group = byDepth.get(depth) ?? [];
      group.push(dir);
      byDepth.set(depth, group);
    }
    for (const depth of [...byDepth.keys()].sort((a, b) => b - a))
      await forEachConcurrent(byDepth.get(depth)!, options, async (dir) => {
        const full = path.join(staging, dir.relative);
        directoryModes.push(full);
        await chmod(full, dir.identity.mode & 0o7777);
      });
    options.signal?.throwIfAborted();
    await rename(staging, target);
    // Completion is reported only after the entire snapshot and provenance are published.
    // Callback errors after publication must not misrepresent a valid snapshot as a failed copy.
    try {
      report(count, directories.length, bytesCopied, files.length, true);
    } catch {
      /* already published */
    }
    return { count, digest };
  } catch (error) {
    // Restore access in case a source directory was read-only. Only our unique staging tree is removed.
    for (const full of directoryModes.reverse()) await chmod(full, 0o700).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
export function validateGeneratedFiles(
  files: unknown,
  outputDir: string,
  maxFiles = 12,
): GeneratedFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > maxFiles)
    throw new Error(`Generator must return between 1 and ${maxFiles} test files.`);
  const seen = new Set<string>();
  return files.map((file) => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string')
      throw new Error('Invalid generated file.');
    const name = file.path;
    if (
      !name.startsWith(outputDir + '/') ||
      name.includes('\\') ||
      name.split('/').some((p: string) => p === '..' || p === '.' || !p) ||
      !/\.(?:java|[jt]s)$/.test(name) ||
      /[\x00-\x1f]/.test(name)
    )
      throw new Error(`Generated path is outside the allowed test folder: ${name}`);
    if (seen.has(name.toLowerCase()) || file.content.length > 150_000 || !file.content.trim())
      throw new Error('Duplicate, empty, or oversized generated test.');
    seen.add(name.toLowerCase());
    return { path: name, content: file.content };
  });
}
export async function writeGeneratedFiles(
  root: string,
  files: GeneratedFile[],
  outputDir: string,
): Promise<string> {
  const validated = validateGeneratedFiles(files, outputDir, 100);
  if (validated.reduce((n, file) => n + file.content.length, 0) > 5_000_000)
    throw new Error('Generated batch exceeds the 5 MB code limit. Select fewer cases.');
  const canonical = await realpath(root);
  // Validate the entire batch before writing any file.
  for (const file of validated) {
    let current = canonical;
    for (const part of file.path.split('/')) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error('Generated paths cannot traverse symlinks.');
        if (current === path.join(canonical, file.path))
          throw new Error(`Refusing to overwrite existing file: ${file.path}`);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  let patch = '';
  for (const file of validated) {
    const full = path.join(canonical, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content, { flag: 'wx' });
    const lines = file.content.replace(/\n$/, '').split('\n');
    patch += `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}\n`;
  }
  await writeFile(path.join(root, '.journeyproof/generated.patch'), patch);
  return patch;
}
