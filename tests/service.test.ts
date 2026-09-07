import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JourneyService} from '../src/core/service';
import {writeGeneratedFiles} from '../src/core/repository';

test('closing the service awaits cancellation and records no successful verification',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'journeyproof-service-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'project');await mkdir(path.join(workspace,'.journeyproof'),{recursive:true});
  const files=[{path:'tests/journeyproof/a.spec.ts',content:'// generated test\n'}];const patch=await writeGeneratedFiles(workspace,files,'tests/journeyproof');
  const service=new JourneyService(root,'/unused');service.state.generation={provider:'portable',summary:'test',files,warnings:[],workspace,patch,generatedAt:new Date().toISOString()};
  const run=service.verify({command:{executable:process.execPath,args:['-e',"require('fs').writeFileSync('ready','yes');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],label:'shutdown fixture'},repeats:1});
  for(let i=0;i<100;i++){try{await access(path.join(workspace,'ready'));break;}catch{await new Promise(r=>setTimeout(r,10));}}
  await service.close();await run;
  assert.equal(service.state.phase,'idle');assert.equal(service.state.verification?.status,'cancelled');
});

test('export refuses a changed test instead of pairing stale tests with passing evidence',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'journeyproof-export-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'project');await mkdir(path.join(workspace,'.journeyproof'),{recursive:true});
  const files=[{path:'tests/journeyproof/a.spec.ts',content:'expect(total).toBe(90);\n'}];const patch=await writeGeneratedFiles(workspace,files,'tests/journeyproof');
  const service=new JourneyService(root,'/unused');service.state.scenario={schemaVersion:1,id:'scenario',name:'coupon',startUrl:'http://localhost/',createdAt:new Date().toISOString(),events:[],assertions:[],network:[],warnings:[]};
  service.state.generation={provider:'portable',summary:'test',files,warnings:[],workspace,patch,generatedAt:new Date().toISOString()};
  await writeFile(path.join(workspace,files[0].path),'expect(total).toBe(95);\n');
  await assert.rejects(service.exportTo(root),/changed on disk/);
  await service.close();
});
