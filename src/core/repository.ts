import { readdir, readFile, stat, lstat, mkdir, copyFile, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Project, GeneratedFile } from '../shared/types';

const OMIT = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.gradle', '.idea', '.vscode', '.next', '.venv', 'venv', 'coverage', 'test-results', 'playwright-report', '.journeyproof', '.codex', '.claude', '.ssh', '.aws', '.npmrc', '.yarnrc', '.pypirc', '.DS_Store']);
export function excluded(name: string): boolean { return OMIT.has(name) || /^\.env(?:\.|$)/.test(name) || /(?:\.pem|\.key|\.p12|\.pfx|credentials\.json|auth\.json)$/i.test(name); }
export function scrubText(value: string): string {
  return value.replace(/\b(?:sk|ghp|github_pat|glpat)[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/(["'](?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1"[REDACTED]"')
    .replace(/((?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)["']?[^\s"',;]+["']?/gi, '$1"[REDACTED]"');
}
export async function verifyGeneratedBytes(root: string, files: GeneratedFile[]): Promise<Record<string,string>> {
  const hashes: Record<string,string> = {};
  const canonical = await realpath(root);
  for (const file of files) {
    const full = path.join(canonical,file.path); const actual = await realpath(full);
    if (!actual.startsWith(canonical + path.sep) || (await lstat(full)).isSymbolicLink()) throw new Error('A generated file now points outside its workspace. Regenerate before verifying.');
    const disk = await readFile(full,'utf8');
    if (disk !== file.content) throw new Error(`Generated test changed on disk: ${file.path}. Regenerate before verifying or exporting so the evidence matches the test.`);
    hashes[file.path] = createHash('sha256').update(disk).digest('hex');
  }
  return hashes;
}
export async function listProjectFiles(root: string, maxFiles = 8000): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('Project exceeds the supported directory depth. Choose a smaller module folder.');
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (excluded(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) { found.push(path.relative(root, full)); if (found.length > maxFiles) throw new Error('This folder contains more than 8,000 source files. Choose the test module folder.'); }
    }
  }
  await walk(root, 0); return found;
}
export async function inspectProject(input: string): Promise<Project> {
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project folder.');
  const files = await listProjectFiles(root);
  const read = async (f: string) => { try { return (await readFile(path.join(root, f), 'utf8')).slice(0, 40_000); } catch { return ''; } };
  const pkgText = await read('package.json'); let pkg: any = {};
  try { pkg = JSON.parse(pkgText || '{}'); } catch { throw new Error('The project package.json is not valid JSON.'); }
  const javaBuild = await read('pom.xml') || await read('build.gradle') || await read('build.gradle.kts');
  const java = files.includes('pom.xml') || files.some(f => /^build\.gradle/.test(f));
  const testFiles = files.filter(f => /(?:\.spec\.[jt]sx?$|\.test\.[jt]sx?$|Test\.java$|src\/test\/.*\.java$)/.test(f)).slice(0, 5);
  const helperFiles = files.filter(f => /(?:pages?|fixtures?|support|helpers?)\//i.test(f) && /\.(?:java|[jt]s)$/.test(f)).slice(0, 4);
  const configFiles = ['package.json','pom.xml','build.gradle','build.gradle.kts','playwright.config.ts','playwright.config.js'].filter(f => files.includes(f));
  const contextFiles = [...new Set([...testFiles,...helperFiles,...configFiles])];
  const examples = await Promise.all(contextFiles.map(async f => ({ path: f, content: scrubText((await read(f)).slice(0, 10_000)) })));
  const clues = javaBuild + pkgText + examples.map(e => e.content).join('\n');
  const framework = java ? /playwright/i.test(clues) ? 'playwright-java' : /selenium/i.test(clues) ? 'selenium-java' : 'unknown' : /playwright/i.test(clues) || files.some(f => /playwright\.config/.test(f)) ? 'playwright-ts' : 'unknown';
  const buildTool = java ? files.includes('pom.xml') ? 'Maven' : 'Gradle' : pkgText ? 'npm' : 'Unconfigured';
  const commands = java ? [{ executable: files.includes('pom.xml') ? files.includes('mvnw') ? './mvnw' : 'mvn' : files.includes('gradlew') ? './gradlew' : 'gradle', args: ['test'], label: `${buildTool} tests` }] : pkg.scripts?.test ? [{ executable: 'npm', args: ['test'], label: 'Project test script' }] : framework === 'playwright-ts' ? [{ executable: 'npx', args: ['--no-install', 'playwright', 'test'], label: 'Playwright tests' }] : [];
  return { id: randomUUID(), name: path.basename(root), path: root, framework, buildTool, summary: `${files.length} source files · ${testFiles.length} test examples · ${framework === 'unknown' ? 'Framework needs review' : framework.replaceAll('-', ' ')}`, examples, commands, outputDir: java ? 'src/test/java/journeyproof' : 'tests/journeyproof' };
}
export async function snapshotProject(project: Project, destination: string): Promise<{ count: number; digest: string }> {
  const root = await realpath(project.path); const target = path.resolve(destination);
  if (target === root || target.startsWith(root + path.sep)) throw new Error('The isolated workspace must be outside the connected project.');
  const files = await listProjectFiles(root); let total = 0; const hash = createHash('sha256');
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const source = path.join(root, file); const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Project changed during snapshot. Please retry.');
    total += info.size;
    if (info.size > 20_000_000 || total > 250_000_000) throw new Error('Project exceeds the 250 MB source snapshot limit. Select a smaller module.');
    const actual = await realpath(source);
    if (!actual.startsWith(root + path.sep)) throw new Error('Project path escaped its folder.');
    const data = await readFile(actual); hash.update(file).update(data);
    const output = path.join(target, file); await mkdir(path.dirname(output), { recursive: true });
    await copyFile(actual, output);
  }
  const digest = hash.digest('hex');
  await mkdir(path.join(target, '.journeyproof'), { recursive: true });
  await writeFile(path.join(target, '.journeyproof/provenance.json'), JSON.stringify({ source: root, digest, files: files.length, createdAt: new Date().toISOString(), excluded: [...OMIT], symlinks: 'excluded' }, null, 2));
  return { count: files.length, digest };
}
export function validateGeneratedFiles(files: unknown, outputDir: string): GeneratedFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > 12) throw new Error('Generator must return between 1 and 12 test files.');
  const seen = new Set<string>();
  return files.map(file => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Invalid generated file.');
    const name = file.path;
    if (!name.startsWith(outputDir + '/') || name.includes('\\') || name.split('/').some((p: string) => p === '..' || p === '.' || !p) || !/\.(?:java|[jt]s)$/.test(name) || /[\x00-\x1f]/.test(name)) throw new Error(`Generated path is outside the allowed test folder: ${name}`);
    if (seen.has(name.toLowerCase()) || file.content.length > 150_000 || !file.content.trim()) throw new Error('Duplicate, empty, or oversized generated test.');
    seen.add(name.toLowerCase()); return { path: name, content: file.content };
  });
}
export async function writeGeneratedFiles(root: string, files: GeneratedFile[], outputDir: string): Promise<string> {
  const validated = validateGeneratedFiles(files, outputDir); const canonical = await realpath(root);
  // Validate the entire batch before writing any file.
  for (const file of validated) {
    let current = canonical;
    for (const part of file.path.split('/')) {
      current = path.join(current, part);
      try { const info = await lstat(current); if (info.isSymbolicLink()) throw new Error('Generated paths cannot traverse symlinks.'); if (current === path.join(canonical, file.path)) throw new Error(`Refusing to overwrite existing file: ${file.path}`); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  let patch = '';
  for (const file of validated) {
    const full = path.join(canonical, file.path); await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content, { flag: 'wx' });
    const lines = file.content.replace(/\n$/, '').split('\n');
    patch += `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
  }
  await writeFile(path.join(root, '.journeyproof/generated.patch'), patch); return patch;
}
