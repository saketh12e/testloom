import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { excluded, scrubText } from './repository';

const PAGE_LIMIT = 200;
const READ_LIMIT = 64 * 1024;
const SCAN_LIMIT = 8 * 1024 * 1024;
const TIME_LIMIT = 5000;
const ENTRY_LIMIT = 250_000;
const MAX_LINE = 64 * 1024;
const integer = (maximum: number, minimum = 1) => ({ type: 'integer', minimum, maximum });
const scopeProperties = {
  path: { type: 'string', description: 'Relative directory; omit for the snapshot root.' },
  glob: { type: 'string', description: 'Root-relative path glob: *, **, ?; case insensitive.' },
};
const pageProperties = {
  ...scopeProperties,
  cursor: { type: 'string', description: 'Opaque nextCursor from the same query and snapshot.' },
  limit: integer(PAGE_LIMIT),
};

export const REPOSITORY_TOOL_DEFINITIONS: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] = [
  {
    name: 'repository_list',
    description:
      'List allowed source paths on demand, at most 200 per page. Follow nextCursor; a partial page is never proof of absence. No file contents are returned.',
    inputSchema: { type: 'object', properties: pageProperties, additionalProperties: false },
  },
  {
    name: 'repository_search_paths',
    description:
      'Find source paths by case-insensitive substring query and/or root-relative glob, with bounded pagination. Use path to narrow large repositories.',
    inputSchema: {
      type: 'object',
      properties: { ...pageProperties, query: { type: 'string', minLength: 1, maxLength: 500 } },
      additionalProperties: false,
    },
  },
  {
    name: 'repository_grep',
    description:
      'Search allowed text files for a literal substring (no regex). Bounded by scanned bytes, results, entries and time; reports truncation and skipped files. Narrow path/glob when incomplete.',
    inputSchema: {
      type: 'object',
      properties: {
        ...scopeProperties,
        query: { type: 'string', minLength: 1, maxLength: 500 },
        caseSensitive: { type: 'boolean' },
        maxResults: integer(PAGE_LIMIT),
        maxBytes: integer(SCAN_LIMIT),
        timeoutMs: integer(TIME_LIMIT),
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'repository_read',
    description:
      'Read scrubbed text, capped at 64 KiB and 1000 lines. Use nextOffset for continuation, or startLine (1-based). Incomplete/oversized lines are omitted, never exposed in fragments; offset inside a line skips that line.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: integer(Number.MAX_SAFE_INTEGER, 0),
        startLine: integer(10_000_000),
        maxBytes: integer(READ_LIMIT),
        maxLines: integer(1000),
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {}
class BudgetStop extends Error {}
class BinaryFile extends Error {}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolError('Repository operation cancelled.');
}
function relative(input: unknown, allowRoot = false): string {
  if (allowRoot && (input === undefined || input === '' || input === '.')) return '';
  if (
    typeof input !== 'string' ||
    input.length > 4096 ||
    !input ||
    input.startsWith('/') ||
    /[\\\x00-\x1f\x7f:*?]/.test(input) ||
    input.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new ToolError('Use a relative repository path without traversal or wildcards.');
  return input;
}
function globInput(input: unknown): string | undefined {
  if (input === undefined) return;
  if (
    typeof input !== 'string' ||
    !input ||
    input.length > 500 ||
    input.startsWith('/') ||
    /[\\\x00-\x1f\x7f:]/.test(input) ||
    input.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new ToolError('Use a relative path glob with only *, ** and ? wildcards.');
  return input.toLowerCase();
}

// Wildcard matching uses bounded dynamic programming, not backtracking regexes.
function segmentMatch(pattern: string, value: string): boolean {
  let row = new Uint8Array(value.length + 1);
  row[0] = 1;
  for (const char of pattern) {
    const next = new Uint8Array(value.length + 1);
    if (char === '*') next[0] = row[0];
    for (let i = 1; i <= value.length; i++)
      next[i] =
        char === '*'
          ? row[i] || next[i - 1]
          : char === '?' || char === value[i - 1]
            ? row[i - 1]
            : 0;
    row = next;
  }
  return !!row[value.length];
}
function globMatch(pattern: string, value: string, descendants = false): boolean {
  const parts = value.toLowerCase().split('/');
  let row = new Uint8Array(parts.length + 1);
  row[0] = 1;
  for (const part of pattern.split('/')) {
    const next = new Uint8Array(parts.length + 1);
    if (part === '**') next[0] = row[0];
    for (let i = 1; i <= parts.length; i++)
      next[i] =
        part === '**'
          ? row[i] || next[i - 1]
          : row[i - 1] && segmentMatch(part, parts[i - 1])
            ? 1
            : 0;
    row = next;
  }
  return descendants ? row.some(Boolean) : !!row[parts.length];
}
function deniedPart(part: string): boolean {
  const lower = part.toLowerCase();
  return (
    excluded(part) ||
    excluded(lower) ||
    /^(?:agents\.md|claude\.md)(?:\..*)?$/i.test(part) ||
    /^(?:\.agent-memory|\.config|\.cursor|\.windsurf|\.docker|\.azure|\.kube|\.gnupg|\.gem|\.netrc|_netrc|\.gitconfig|\.git-credentials|\.mcp\.json|\.claude\.json|\.yarnrc(?:\.yml)?|\.npmrc|\.pypirc|\.env.*)$/i.test(
      part,
    ) ||
    /^(?:credentials|secrets?|auth)(?:\.[^.]+)?$/i.test(part) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?$/i.test(part) ||
    /\.(?:keystore|jks)$/i.test(part)
  );
}
function scrub(value: string): string {
  return scrubText(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_.=:-]+/gi, '[REDACTED AUTHORIZATION]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization|signature|code)=)[^&#\s"'<>]*/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|token)\s*[:=]\s*)[^\r\n]+/gi,
      '$1[REDACTED]',
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'string' ? scrub(item) : item));

async function systemRoot(full: string): Promise<string> {
  // macOS exposes its OS temporary directory through these fixed aliases.
  // Canonicalize only those exact system links; never normalize repository links.
  if (process.platform === 'darwin') {
    for (const alias of ['/var', '/tmp']) {
      if (
        (full === alias || full.startsWith(alias + '/')) &&
        (await realpath(alias)) === `/private${alias}`
      )
        return `/private${full}`;
    }
  }
  return full;
}

/** Check the lexical root too: realpath alone silently accepts symlink ancestors. */
async function checkedPath(full: string, directory = false) {
  const parsed = path.parse(full);
  let current = parsed.root;
  let info = await lstat(current);
  const parts = full.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory()))
      throw new ToolError(
        'Repository paths and every ancestor must be real directories, never symlinks.',
      );
  }
  if (directory && !info.isDirectory()) throw new ToolError('Repository path is not a directory.');
  if ((await realpath(full)) !== full) throw new ToolError('Repository path changed or is unsafe.');
  return info;
}

class Repository {
  constructor(
    readonly root: string,
    readonly exclusions: string[],
  ) {}
  denied(name: string): boolean {
    return (
      name.split('/').some(deniedPart) || this.exclusions.some((p) => globMatch(p, name, true))
    );
  }
  full(name: string): string {
    if (name && this.denied(name)) throw new ToolError('Repository path is excluded or protected.');
    const full = path.resolve(this.root, name);
    if (full !== this.root && !full.startsWith(this.root + path.sep))
      throw new ToolError('Repository path is outside the source snapshot.');
    return full;
  }
  async file(name: string): Promise<FileHandle> {
    const full = this.full(name);
    const before = await checkedPath(full);
    if (!before.isFile() || before.nlink !== 1)
      throw new ToolError('Only regular, unlinked source files can be read.');
    const handle = await open(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      const after = await checkedPath(full);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.ino !== after.ino ||
        opened.dev !== after.dev
      )
        throw new ToolError('Repository file changed while opening. Retry with a fresh snapshot.');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
class Budget {
  bytes = 0;
  entries = 0;
  readonly reasons = new Set<string>();
  readonly started = Date.now();
  constructor(
    readonly maxBytes: number,
    readonly timeoutMs: number,
    readonly signal?: AbortSignal,
  ) {}
  check(): void {
    cancelled(this.signal);
    if (Date.now() - this.started >= this.timeoutMs) this.stop('time_limit');
  }
  stop(reason: string): never {
    this.reasons.add(reason);
    throw new BudgetStop();
  }
}

async function* files(
  repo: Repository,
  dir: string,
  budget: Budget,
  depth = 0,
): AsyncGenerator<string> {
  budget.check();
  if (depth > 64) {
    budget.reasons.add('depth_limit');
    return;
  }
  const full = repo.full(dir);
  const before = await checkedPath(full, true);
  const handle = await opendir(full);
  try {
    const after = await checkedPath(full, true);
    if (before.ino !== after.ino || before.dev !== after.dev)
      throw new ToolError('Repository directory changed during enumeration.');
    for await (const entry of handle) {
      budget.check();
      if (++budget.entries > ENTRY_LIMIT) budget.stop('entry_limit');
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      // Filesystem names are untrusted as well as tool arguments.
      if (
        name.length > 4096 ||
        /[\\\x00-\x1f\x7f:*?]/.test(name) ||
        repo.denied(name) ||
        entry.isSymbolicLink()
      )
        continue;
      if (entry.isDirectory()) yield* files(repo, name, budget, depth + 1);
      else if (entry.isFile()) yield name;
    }
  } finally {
    await handle.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
}

type Line = { text: string | null; start: number; end: number; complete: boolean };
async function* lines(
  handle: FileHandle,
  offset: number,
  budget: Budget,
  fileLimit = SCAN_LIMIT,
): AsyncGenerator<Line> {
  let position = offset,
    start = offset,
    parts: Buffer[] = [],
    length = 0,
    used = 0;
  // Never expose a secret's suffix by starting a read in the middle of a line.
  let discard = false;
  if (offset) {
    const previous = Buffer.alloc(1);
    const previousRead = await handle.read(previous, 0, 1, offset - 1);
    budget.bytes += previousRead.bytesRead;
    discard = previous[0] !== 10;
  }
  const chunk = Buffer.alloc(16 * 1024);
  while (true) {
    budget.check();
    const size = Math.min(chunk.length, budget.maxBytes - budget.bytes, fileLimit - used);
    if (size <= 0) {
      if (length) yield { text: null, start, end: position, complete: false };
      budget.stop(budget.bytes >= budget.maxBytes ? 'byte_limit' : 'file_byte_limit');
    }
    const { bytesRead } = await handle.read(chunk, 0, size, position);
    if (!bytesRead) {
      if (length)
        yield {
          text: discard || length > MAX_LINE ? null : Buffer.concat(parts).toString('utf8'),
          start,
          end: position,
          complete: true,
        };
      return;
    }
    budget.bytes += bytesRead;
    used += bytesRead;
    if (chunk.subarray(0, bytesRead).includes(0)) throw new BinaryFile();
    let from = 0;
    while (from < bytesRead) {
      const found = chunk.indexOf(10, from);
      const to = found >= 0 && found < bytesRead ? found + 1 : bytesRead;
      length += to - from;
      if (!discard && length <= MAX_LINE) parts.push(Buffer.from(chunk.subarray(from, to)));
      else parts = [];
      position += to - from;
      if (found >= 0 && found < bytesRead) {
        yield {
          text: discard || length > MAX_LINE ? null : Buffer.concat(parts).toString('utf8'),
          start,
          end: position,
          complete: true,
        };
        start = position;
        length = 0;
        parts = [];
        discard = false;
      }
      from = to;
    }
  }
}

function number(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const n = args[key] === undefined ? fallback : args[key];
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max)
    throw new ToolError(`Invalid ${key}; expected a whole number from ${min} to ${max}.`);
  return n;
}
function query(args: Record<string, unknown>, required: boolean): string {
  if (args.query === undefined && !required) return '';
  if (
    typeof args.query !== 'string' ||
    !args.query ||
    args.query.length > 500 ||
    /[\x00-\x1f\x7f]/.test(args.query)
  )
    throw new ToolError('Supply a literal query of 1 to 500 characters.');
  return args.query;
}

async function list(
  repo: Repository,
  args: Record<string, unknown>,
  searching: boolean,
  signal?: AbortSignal,
) {
  const dir = relative(args.path, true),
    glob = globInput(args.glob);
  const term = query(args, false).toLowerCase();
  if (searching && !term && !glob) throw new ToolError('Supply a path query or glob.');
  const limit = number(args, 'limit', PAGE_LIMIT, PAGE_LIMIT);
  const scope = createHash('sha256')
    .update(JSON.stringify([repo.root, repo.exclusions, dir, glob, term]))
    .digest('hex');
  let offset = 0;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length > 300)
      throw new ToolError('Invalid repository cursor.');
    try {
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
      if (
        cursor.scope !== scope ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > ENTRY_LIMIT
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      throw new ToolError(
        'Cursor does not match this repository query. Restart or narrow the search.',
      );
    }
  }
  const budget = new Budget(0, TIME_LIMIT, signal),
    paths: string[] = [];
  let next = offset;
  try {
    for await (const name of files(repo, dir, budget)) {
      if (budget.entries <= offset) continue;
      next = budget.entries;
      if ((term && !name.toLowerCase().includes(term)) || (glob && !globMatch(glob, name)))
        continue;
      paths.push(name);
      if (paths.length >= limit) budget.stop('page_limit');
    }
  } catch (error) {
    if (!(error instanceof BudgetStop)) throw error;
  }
  const truncated = budget.reasons.size > 0;
  return {
    paths,
    truncated,
    reasons: [...budget.reasons],
    scannedEntries: budget.entries,
    nextCursor:
      truncated && next > offset
        ? Buffer.from(JSON.stringify({ scope, offset: next })).toString('base64url')
        : null,
    note: truncated
      ? 'Partial enumeration; follow nextCursor or narrow path/glob. An empty page is not proof of absence.'
      : undefined,
  };
}

async function read(repo: Repository, args: Record<string, unknown>, signal?: AbortSignal) {
  const name = relative(args.path);
  if (args.offset !== undefined && args.startLine !== undefined)
    throw new ToolError('Use offset or startLine, not both.');
  const offset = number(args, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
  const startLine = number(args, 'startLine', 1, 10_000_000);
  const maxBytes = number(args, 'maxBytes', READ_LIMIT, READ_LIMIT);
  const maxLines = number(args, 'maxLines', 200, 1000);
  const budget = new Budget(SCAN_LIMIT, TIME_LIMIT, signal);
  const handle = await repo.file(name);
  let content = '',
    outputBytes = 0,
    lineNumber = 0,
    returnedLines = 0,
    omittedLines = 0,
    nextOffset = offset;
  try {
    const size = (await handle.stat()).size;
    if (offset > size) throw new ToolError('Read offset is past the end of the file.');
    try {
      for await (const line of lines(handle, offset, budget)) {
        lineNumber++;
        if (lineNumber < startLine) {
          nextOffset = line.end;
          continue;
        }
        const text = line.text === null ? '' : scrub(line.text);
        const bytes = Buffer.byteLength(text);
        if (bytes > maxBytes) {
          omittedLines++;
          nextOffset = line.end;
          budget.reasons.add('oversized_line');
          continue;
        }
        if (outputBytes + bytes > maxBytes || returnedLines >= maxLines) {
          budget.reasons.add('page_limit');
          break;
        }
        nextOffset = line.end;
        if (line.text === null) {
          omittedLines++;
          budget.reasons.add('omitted_line');
          continue;
        }
        content += text;
        outputBytes += bytes;
        returnedLines++;
      }
    } catch (error) {
      if (error instanceof BinaryFile)
        throw new ToolError('Repository read supports text files only.');
      if (!(error instanceof BudgetStop)) throw error;
    }
    return {
      path: name,
      content,
      returnedLines,
      omittedLines,
      scannedBytes: budget.bytes,
      truncated: nextOffset < size || budget.reasons.size > 0,
      reasons: [...budget.reasons],
      nextOffset: nextOffset < size ? nextOffset : null,
    };
  } finally {
    await handle.close();
  }
}

async function grep(repo: Repository, args: Record<string, unknown>, signal?: AbortSignal) {
  const dir = relative(args.path, true),
    glob = globInput(args.glob),
    term = query(args, true);
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean')
    throw new ToolError('caseSensitive must be boolean.');
  const needle = args.caseSensitive ? term : term.toLowerCase();
  const maxResults = number(args, 'maxResults', 100, PAGE_LIMIT);
  const budget = new Budget(
    number(args, 'maxBytes', SCAN_LIMIT, SCAN_LIMIT),
    number(args, 'timeoutMs', TIME_LIMIT, TIME_LIMIT),
    signal,
  );
  const matches: { path: string; line: number; text: string; truncated: boolean }[] = [];
  let scannedFiles = 0,
    skippedFiles = 0;
  try {
    for await (const name of files(repo, dir, budget)) {
      if (glob && !globMatch(glob, name)) continue;
      const handle = await repo.file(name);
      scannedFiles++;
      let lineNumber = 0;
      try {
        for await (const line of lines(handle, 0, budget, 1024 * 1024)) {
          budget.check();
          lineNumber++;
          if (line.text === null) {
            budget.reasons.add('omitted_line');
            continue;
          }
          const safe = scrub(line.text).replace(/\r?\n$/, '');
          // Match scrubbed text, so repeated grep queries cannot act as a secret oracle.
          if (!(args.caseSensitive ? safe : safe.toLowerCase()).includes(needle)) continue;
          matches.push({
            path: name,
            line: lineNumber,
            text: safe.slice(0, 500),
            truncated: safe.length > 500,
          });
          if (matches.length >= maxResults) budget.stop('result_limit');
        }
      } catch (error) {
        if (error instanceof BinaryFile) skippedFiles++;
        else if (
          error instanceof BudgetStop &&
          budget.bytes < budget.maxBytes &&
          budget.reasons.has('file_byte_limit') &&
          !budget.reasons.has('time_limit') &&
          matches.length < maxResults
        )
          skippedFiles++;
        else throw error;
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetStop)) throw error;
  }
  return {
    matches,
    scannedFiles,
    skippedFiles,
    scannedBytes: budget.bytes,
    scannedEntries: budget.entries,
    elapsedMs: Date.now() - budget.started,
    truncated: budget.reasons.size > 0,
    reasons: [...budget.reasons],
    note: budget.reasons.size
      ? 'Partial content search. Narrow path/glob; no match is not proof of absence.'
      : undefined,
  };
}

export async function executeRepositoryTool(
  root: string,
  excludedPaths: string[],
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<string> {
  try {
    cancelled(signal);
    const definition = REPOSITORY_TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!definition) throw new ToolError('Unknown repository tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new ToolError('Tool arguments must be an object.');
    const input = args as Record<string, unknown>;
    const properties = definition.inputSchema.properties as Record<string, unknown>;
    if (Object.keys(input).some((key) => !Object.hasOwn(properties, key)))
      throw new ToolError('Unknown repository tool argument.');
    if (
      typeof root !== 'string' ||
      !path.isAbsolute(root) ||
      root !== path.resolve(root) ||
      root === path.parse(root).root ||
      root.split(path.sep).some(deniedPart)
    )
      throw new ToolError('Use an absolute, isolated source snapshot root.');
    if (!Array.isArray(excludedPaths) || excludedPaths.length > 100)
      throw new ToolError('Invalid repository exclusions.');
    const exclusions = excludedPaths.map((p) => globInput(p)!);
    if (exclusions.some((p) => !p)) throw new ToolError('Invalid repository exclusions.');
    const canonical = await systemRoot(root);
    await checkedPath(canonical, true);
    const repo = new Repository(canonical, exclusions);
    const result =
      name === 'repository_read'
        ? await read(repo, input, signal)
        : name === 'repository_grep'
          ? await grep(repo, input, signal)
          : await list(repo, input, name === 'repository_search_paths', signal);
    cancelled(signal);
    return json(result);
  } catch (error) {
    // Never include filesystem errors: they contain absolute paths and raw input.
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      'Repository path is unavailable, unsafe, or changed. Retry with an allowed path in the current snapshot.',
    );
  }
}
