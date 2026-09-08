import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexServerGenerate } from '../src/core/codex-server';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/agents';

test('native Codex sessions resume independently, inspect repository tools, attach images and resolve maximum effort', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'),
    workspace = path.join(root, 'project'),
    cwd = path.join(root, 'case-session');
  await Promise.all([
    mkdir(bin),
    mkdir(path.join(workspace, 'backend'), { recursive: true }),
    mkdir(cwd),
  ]);
  await writeFile(path.join(workspace, 'backend/cart.ts'), 'export const discountPercent = 10;');
  const log = path.join(root, 'rpc.jsonl');
  const executable = path.join(bin, 'codex');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'); const crypto=require('node:crypto');
const rl=require('node:readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
let thread,turn,input;
rl.on('line',line=>{ const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
if(m.method==='initialize') send({id:m.id,result:{}});
else if(m.method==='config/read') send({id:m.id,result:{config:{mcp_servers:{unrelated:{enabled:true}}}}});
else if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||crypto.randomUUID();send({id:m.id,result:{thread:{id:thread},model:'mock-model'}});}
else if(m.method==='model/list')send({id:m.id,result:{data:[{model:'mock-model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]}],nextCursor:null}});
else if(m.method==='turn/start'){input=m.params.input;turn=crypto.randomUUID();send({id:m.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});send({id:700,method:'item/tool/call',params:{threadId:thread,turnId:turn,callId:'call',tool:'repository_read',arguments:{path:'backend/cart.ts'}}});}
else if(m.id===700){
send({method:'turn/completed',params:{threadId:'another-case',turn:{id:'wrong',status:'completed'}}});
const value={backend:m.result.contentItems[0].text,images:input.filter(v=>v.type==='localImage').length};
send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(value)}}});
send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:[]}}});
}
});
`,
  );
  await chmod(executable, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + originalPath;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  let id = '';
  const options = {
    session: { cwd },
    onSession: (value: string) => {
      id = value;
    },
    evidenceImages: [
      {
        path: path.join(root, 'shot.png'),
        mimeType: 'image/png' as const,
        label: 'Recorded event 1',
      },
    ],
  };
  const first = (await codexServerGenerate(
    'current requirements',
    {},
    workspace,
    DEFAULT_AGENT_SETTINGS,
    options,
  )) as any;
  assert.match(first.backend, /discountPercent/);
  assert.equal(first.images, 1);
  const firstId = id;
  await codexServerGenerate('revised requirements', {}, workspace, DEFAULT_AGENT_SETTINGS, {
    ...options,
    session: { cwd, id },
  });
  assert.equal(id, firstId);
  await codexServerGenerate('independent case', {}, workspace, DEFAULT_AGENT_SETTINGS, {
    ...options,
    session: { cwd },
  });
  assert.notEqual(id, firstId);
  const messages = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(messages.filter((m) => m.method === 'thread/start').length, 2);
  assert.equal(messages.find((m) => m.method === 'thread/resume').params.threadId, firstId);
  const start = messages.find((m) => m.method === 'thread/start').params;
  assert.equal(start.ephemeral, false);
  assert.equal(start.config['mcp_servers.unrelated.enabled'], false);
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.sandbox, 'read-only');
  for (const turn of messages.filter((m) => m.method === 'turn/start')) {
    assert.equal(turn.params.effort, 'xhigh');
    assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
  }
  assert.equal(
    await readFile(path.join(workspace, 'backend/cart.ts'), 'utf8'),
    'export const discountPercent = 10;',
  );
});

test('Codex cancellation interrupts an owned stalled connection', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-rpc-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex');
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdin.resume(); setInterval(()=>{},1000);`,
  );
  await chmod(executable, 0o700);
  const original = process.env.PATH;
  process.env.PATH = root + path.delimiter + original;
  t.after(() => {
    process.env.PATH = original;
  });
  const controller = new AbortController();
  const run = codexServerGenerate('test', {}, root, DEFAULT_AGENT_SETTINGS, {
    session: { cwd: root },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, /cancelled/);
});
