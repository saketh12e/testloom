import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JourneyService } from '../src/core/service';
import { demoCases } from '../src/core/demo';

test('case sessions survive reopening, stay separate, and reset when context access changes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-service-sessions-'));
  const storage = path.join(root, 'app'),
    source = path.join(root, 'source'),
    bin = path.join(root, 'bin');
  await Promise.all([mkdir(storage), mkdir(source), mkdir(bin)]);
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ devDependencies: { '@playwright/test': '1.63.0' } }),
  );
  const sourceBytes = await readFile(path.join(source, 'package.json'), 'utf8');
  const fake = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0);}
const crypto=require('node:crypto'); const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
let id; require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='thread/name/set')send({id:m.id,result:{}});
else if(m.method==='config/read')send({id:m.id,result:{config:{}}});
else if(m.method==='thread/start'||m.method==='thread/resume'){id=m.params.threadId||crypto.randomUUID();send({id:m.id,result:{thread:{id},model:'test-model'}});}
else if(m.method==='turn/start'){
const turn=crypto.randomUUID();const text=m.params.input[0].text;const dir=/Output only NEW files under (.+?)\\//.exec(text);
const match=/Output only NEW files under ([^\\n]+)\\/ with/.exec(text);
const response={summary:'Proposed test',warnings:[],files:[{path:match[1]+'/case.spec.ts',content:'// Proposed test for review; no execution claimed.\\n'}]};
send({id:m.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{threadId:id,turn:{id:turn}}});
send({method:'item/completed',params:{threadId:id,turnId:turn,item:{type:'agentMessage',text:JSON.stringify(response)}}});
send({method:'turn/completed',params:{threadId:id,turn:{id:turn,status:'completed'}}});
}
});`;
  await writeFile(path.join(bin, 'codex'), fake);
  await chmod(path.join(bin, 'codex'), 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  let service = new JourneyService(storage, '/unused');
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.initialize();
  await service.connect(source);
  service.state.cases = demoCases();
  service.state.activeCaseId = service.state.cases[0].id;
  service.state.scenario = service.state.cases[0].scenario;
  await service.saveSettings({ ...service.state.settings, provider: 'codex', effort: 'high' });
  const firstCase = service.state.cases[0].id,
    secondCase = service.state.cases[1].id;
  await service.generate({ mode: 'codex', caseIds: [firstCase, secondCase] });
  const sessions = service.state.agentSessions!;
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].id, sessions[1].id);
  assert.ok(sessions.every((s) => s.turns === 1 && s.status === 'ready'));
  const firstId = sessions[0].id;
  await service.close();
  service = new JourneyService(storage, '/unused');
  await service.initialize();
  const projectId = service.state.project!.id;
  await service.connect(source);
  assert.equal(service.state.project!.id, projectId);
  await service.generate({ mode: 'codex', caseIds: [firstCase] });
  assert.equal(service.state.agentSessions!.find((s) => s.caseId === firstCase)!.id, firstId);
  assert.equal(service.state.agentSessions!.find((s) => s.caseId === firstCase)!.turns, 2);
  await service.saveSettings({ ...service.state.settings, excludedContextPaths: ['private/**'] });
  await service.generate({ mode: 'codex', caseIds: [firstCase] });
  assert.notEqual(service.state.agentSessions!.find((s) => s.caseId === firstCase)!.id, firstId);
  assert.equal(
    service.state.agentSessions!.find((s) => s.caseId === secondCase)!.id,
    sessions[1].id,
  );
  await service.resetAgentSession({ caseId: firstCase, provider: 'codex' });
  assert.equal(
    service.state.agentSessions!.some((s) => s.caseId === firstCase),
    false,
  );
  assert.equal(await readFile(path.join(source, 'package.json'), 'utf8'), sourceBytes);
  assert.equal(service.state.verification, undefined);
});
