import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectProject, snapshotProject, validateGeneratedFiles, writeGeneratedFiles, verifyGeneratedBytes, scrubText } from '../src/core/repository';
import { portableGenerate, validateScenario } from '../src/core/generator';
import { runProcess } from '../src/core/process';
import { verifyWorkspace, inspectPlaywrightReport } from '../src/core/verifier';
import { generationPrompt } from '../src/core/codex';
import type { Project, Scenario } from '../src/shared/types';

const project: Project = { id: 'p', name: 'cart', path: '/test', framework: 'playwright-ts', buildTool: 'npm', summary: '', examples: [], commands: [], outputDir: 'tests/journeyproof' };
const scenario: Scenario = {
  schemaVersion: 1, id: 'abcdef12', name: 'Discount applies', startUrl: 'http://127.0.0.1:4318/', createdAt: '2026-01-01T00:00:00Z', warnings: [], network: [],
  events: [{ id: 'e1', sequence: 1, timestamp: '', action: 'navigate', url: 'http://127.0.0.1:4318/', pageId: 'page-1', label: 'Navigate', locators: [] }, { id: 'e2', sequence: 2, timestamp: '', action: 'click', url: 'http://127.0.0.1:4318/', pageId: 'page-1', label: 'Apply', locators: [{ strategy: 'testId', value: 'apply-coupon' }] }],
  assertions: [{ id: 'a1', description: 'The discount total is $90', kind: 'text', locator: { strategy: 'testId', value: 'total' }, expected: '$90.00', source: 'user' }],
};
test('snapshot excludes credentials, symlinks, dependency caches and preserves source bytes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'journeyproof-core-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source);
  await writeFile(path.join(source,'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '1.63.0' }, scripts: { test: 'playwright test' } }));
  await writeFile(path.join(source,'.env'), 'SECRET=private'); await writeFile(path.join(source,'key.pem'), 'private');
  await mkdir(path.join(source,'node_modules')); await writeFile(path.join(source,'node_modules/cache'), 'cache');
  await writeFile(path.join(root,'outside.txt'), 'outside'); await symlink(path.join(root,'outside.txt'),path.join(source,'linked.txt'));
  const detected = await inspectProject(source); assert.equal(detected.framework,'playwright-ts');
  const before = await readFile(path.join(source,'package.json'),'utf8');
  const snapshot = path.join(root,'snapshot'); const result = await snapshotProject(detected,snapshot);
  assert.equal(result.count,1); assert.equal(result.digest.length,64);
  assert.deepEqual((await readdir(snapshot)).sort(),['.journeyproof','package.json']);
  await writeGeneratedFiles(snapshot,[{path:'tests/journeyproof/example.spec.ts',content:'test code\n'}],detected.outputDir);
  assert.equal(await readFile(path.join(source,'package.json'),'utf8'), before);
  assert.equal((await readdir(source)).includes('tests'),false);
});
test('generation path boundary rejects traversal, source edits, case collisions and unexpected extensions', () => {
  for (const bad of ['../x.ts','tests/journeyproof/../../src/app.ts','/tests/journeyproof/a.ts','tests/journeyproof/a.sh','tests/journeyproof/a\\b.ts','src/main.ts']) assert.throws(() => validateGeneratedFiles([{path:bad,content:'x'}],project.outputDir));
  assert.throws(() => validateGeneratedFiles([{path:'tests/journeyproof/A.ts',content:'x'},{path:'tests/journeyproof/a.ts',content:'x'}],project.outputDir));
});
test('file application rejects symlink escape and overwrite', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'journeyproof-path-')); t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.journeyproof')); await mkdir(path.join(root,'tests')); await symlink(tmpdir(),path.join(root,'tests/journeyproof'));
  await assert.rejects(writeGeneratedFiles(root,[{path:'tests/journeyproof/a.ts',content:'x'}],project.outputDir),/symlink/);
  await rm(path.join(root,'tests/journeyproof')); await mkdir(path.join(root,'tests/journeyproof')); await writeFile(path.join(root,'tests/journeyproof/a.ts'),'original');
  await assert.rejects(writeGeneratedFiles(root,[{path:'tests/journeyproof/a.ts',content:'new'}],project.outputDir),/overwrite/);
  assert.equal(await readFile(path.join(root,'tests/journeyproof/a.ts'),'utf8'),'original');
});
test('portable compiler preserves explicit expected values and safe quoting in TS and Java', () => {
  const s = structuredClone(scenario); s.name = 'A "quoted" journey';
  const ts = portableGenerate(project,s).files[0].content;
  assert.match(ts,/toHaveText\("\$90\.00"\)/); assert.match(ts,/Requirement a1/); assert.ok(!ts.includes('waitForTimeout'));
  const java = portableGenerate({...project, framework:'playwright-java',outputDir:'src/test/java/journeyproof'},s).files[0];
  assert.match(java.content,/hasText\("\$90\.00"\)/); assert.match(java.path,/Test\.java$/);
});
test('navigation observations become assertions rather than bypassing a broken click', () => {
  const s = structuredClone(scenario); s.events.push({...s.events[0],id:'e3',sequence:3,url:'https://example.com/cart'});
  const code = portableGenerate(project,s).files[0].content;
  assert.ok(code.includes('toHaveURL(new RegExp('));
  assert.ok(code.includes('(?:[?#].*)?$'));
  assert.equal((code.match(/page.goto/g)||[]).length,1);
});
test('missing requirements, unsupported steps, redacted credentials and custom rules fail closed', () => {
  assert.throws(()=>validateScenario({...scenario,assertions:[]}),/expected result/);
  assert.throws(()=>portableGenerate(project,{...scenario,warnings:['file upload']}),/unsupported/);
  const secret = structuredClone(scenario); secret.events[1].redacted = true;
  assert.throws(()=>portableGenerate(project,secret),/redacted/);
  const custom = structuredClone(scenario); custom.assertions[0].kind='custom';
  assert.throws(()=>portableGenerate(project,custom),/Codex/);
});
test('Codex prompt excludes screenshot files and labels recorded data untrusted', () => {
  const s=structuredClone(scenario); s.events[0].screenshot='/private/customer.png';
  const prompt=generationPrompt(project,s); assert.ok(!prompt.includes('/private/customer.png')); assert.match(prompt,/untrusted evidence/); assert.match(prompt,/Do not modify ANY files/);
  assert.ok(!scrubText('api_key="sk-secretsecretsecretsecret"').includes('secretsecret'));
  assert.ok(!scrubText('{"password":"SYNTHETIC_SECRET_1234"}').includes('SYNTHETIC_SECRET'));
});
test('execution evidence cannot be exported against changed generated bytes', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'journeyproof-bytes-')); t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.journeyproof'));
  const files=[{path:'tests/journeyproof/a.ts',content:'assert.equal(total,90);\n'}];
  await writeGeneratedFiles(root,files,project.outputDir);
  const hashes=await verifyGeneratedBytes(root,files); assert.equal(hashes[files[0].path].length,64);
  await writeFile(path.join(root,files[0].path),'assert.equal(total,95);\n');
  await assert.rejects(verifyGeneratedBytes(root,files),/changed on disk/);
});
test('test discovery rejects skipped, retry-only, missing and expected-failure reports',()=>{
  const report={config:{rootDir:'/repo/tests'},suites:[{specs:[{file:'journeyproof/a.spec.ts',title:'coupon',tests:[{expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}]}]};
  assert.equal(inspectPlaywrightReport(report,['tests/journeyproof/a.spec.ts'],'/repo').length,1);
  for(const kind of ['skipped','failed']){const r=structuredClone(report);r.suites[0].specs[0].tests[0].results[0].status=kind;assert.throws(()=>inspectPlaywrightReport(r,['tests/journeyproof/a.spec.ts'],'/repo'));}
  const retried=structuredClone(report);retried.suites[0].specs[0].tests[0].results.unshift({status:'failed'});assert.throws(()=>inspectPlaywrightReport(retried,['tests/journeyproof/a.spec.ts'],'/repo'));
  assert.throws(()=>inspectPlaywrightReport(report,['tests/journeyproof/missing.spec.ts'],'/repo'));
});
test('process execution preserves literal arguments, cancellation and timeouts', async () => {
  const literal='$(touch /tmp/should-never-exist); echo hello';
  const result=await runProcess(process.execPath,['-e','console.log(process.argv[1])',literal],{cwd:tmpdir()});
  assert.equal(result.code,0); assert.equal(result.output.trim(),literal);
  const timed=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:tmpdir(),timeoutMs:50}); assert.equal(timed.timedOut,true); assert.notEqual(timed.code,0);
  const controller=new AbortController(); setTimeout(()=>controller.abort(),50);
  const cancelled=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:tmpdir(),signal:controller.signal}); assert.equal(cancelled.cancelled,true);
});
test('verification reports completed failures separately from environment errors and never retries failed checks', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'journeyproof-verify-')); t.after(()=>rm(root,{recursive:true,force:true})); await mkdir(path.join(root,'.journeyproof'));
  const pass=await verifyWorkspace(root,{executable:process.execPath,args:['-e','console.log("one executed assertion")'],label:'test'},2); assert.equal(pass.status,'passed'); assert.equal(pass.runs.length,2);
  const fail=await verifyWorkspace(root,{executable:process.execPath,args:['-e','process.exit(1)'],label:'test'},3); assert.equal(fail.status,'failed'); assert.equal(fail.runs.length,1);
  const missing=await verifyWorkspace(root,{executable:'journeyproof-nonexistent-test-runner',args:[],label:'missing'},1); assert.equal(missing.status,'environment-error');
});
