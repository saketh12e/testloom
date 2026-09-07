import { _electron as electron, chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=await mkdtemp(path.join(tmpdir(),'journeyproof-desktop-'));
const desktop=await electron.launch({...(process.env.JOURNEYPROOF_EXECUTABLE?{executablePath:process.env.JOURNEYPROOF_EXECUTABLE}:{}),args:process.env.JOURNEYPROOF_EXECUTABLE?[]:[path.resolve('.')],env:{...process.env,JOURNEYPROOF_DATA_DIR:root,JOURNEYPROOF_E2E:'1',JOURNEYPROOF_CDP_PORT:'9437'}});
const errors:string[]=[];
try {
  const window=await desktop.firstWindow(); window.on('pageerror',e=>errors.push(e.message));
  await window.getByRole('heading',{name:'Show the journey. Prove the outcome.'}).waitFor();
  await mkdir('assets',{recursive:true});
  await window.screenshot({path:'assets/overview.png'});
  if (process.env.JOURNEYPROOF_SCREENSHOT_ONLY==='1') { console.log('Welcome screen captured.'); }
  else {
    await window.locator('#load-demo').click();
    await window.waitForFunction(()=>!!(document.querySelector('#start-url') as HTMLInputElement)?.value || !(document.querySelector('#error-banner') as HTMLElement).hidden);
    const loaded=await window.evaluate(()=> (window as any).journey.getState());if(loaded.error)throw new Error(loaded.error);
    await window.locator('#start-recording').click();
    await window.locator('#stop-recording').waitFor({state:'visible'});
    let browser;
    for(let i=0;i<50;i++){ try { browser=await chromium.connectOverCDP('http://127.0.0.1:9437');break;}catch{await new Promise(r=>setTimeout(r,200));} }
    assert.ok(browser,'Recording browser exposes the test-only debugging port.');
    const page=browser.contexts()[0].pages()[0];
    await page.getByTestId('add-notebook').click(); await page.getByTestId('add-bag').click();
    await page.getByTestId('coupon').fill('SAVE10'); await page.getByTestId('apply-coupon').click();
    await page.getByTestId('total').filter({hasText:'$90.00'}).waitFor();
    await window.locator('#stop-recording').click();
    await window.waitForFunction(()=>!(document.querySelector('#generator-mode') as HTMLSelectElement)?.disabled);
    await window.locator('#generator-mode').selectOption('portable');
    await window.locator('#generate').click();
    await window.waitForFunction(()=>!(document.querySelector('#verify') as HTMLButtonElement)?.disabled);
    await window.screenshot({path:'assets/recorded-journey.png',style:'.project-path,#generation-workspace{visibility:hidden}'});
    await window.locator('#verify').click();
    let completed=false;
    for(let attempt=0;attempt<600;attempt++){
      const current=await window.evaluate(()=> (window as any).journey.getState());
      if(current.phase==='idle' && current.verification){completed=true;break;}
      if(current.error) throw new Error(current.error);
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(completed,'Verification completed within two minutes');
    await window.screenshot({path:'assets/verified-journey.png',style:'.project-path,#generation-workspace{visibility:hidden}'});
    const state=await window.evaluate(()=> (window as any).journey.getState());
    assert.equal(state.verification.status,'passed'); assert.equal(state.verification.runs.length,2);
    assert.ok(state.verification.discoveredTests?.length,'Generated test discovery was confirmed');
    assert.ok(Object.keys(state.verification.fileHashes||{}).length,'Evidence is bound to generated test bytes');
    assert.ok(state.generation.files[0].content.includes('$90.00'));
    const exportRoot=path.join(root,'exports');await mkdir(exportRoot);
    await desktop.evaluate(({dialog},folder)=>{dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[folder]})) as typeof dialog.showOpenDialog;},exportRoot);
    await window.locator('#export-bundle').click();
    for(let i=0;i<100;i++){if((await readdir(exportRoot)).length)break;await new Promise(r=>setTimeout(r,100));}
    await window.locator('#export-result').filter({hasText:'Exported to'}).waitFor();
    const exported=path.join(exportRoot,(await readdir(exportRoot))[0]);
    const report=JSON.parse(await readFile(path.join(exported,'verification.json'),'utf8'));
    assert.deepEqual(report.fileHashes,state.verification.fileHashes);
    assert.equal(await readFile(path.join(exported,'tests',state.generation.files[0].path),'utf8'),state.generation.files[0].content);
    await mkdir('work',{recursive:true});
    await writeFile('work/desktop-validation.json',JSON.stringify({state,rendererErrors:errors},null,2));
    console.log(JSON.stringify({status:state.verification.status,events:state.scenario.events.length,runs:state.verification.runs.length,exportVerified:true,packaged:!!process.env.JOURNEYPROOF_EXECUTABLE,rendererErrors:errors},null,2));
  }
  assert.deepEqual(errors,[]);
} catch(error) {
  const window=desktop.windows()[0];
  if(window){const state=await window.evaluate(()=> (window as any).journey.getState()).catch(()=>undefined);console.error(JSON.stringify({error:String(error),state},null,2));await mkdir('work',{recursive:true});await window.screenshot({path:'work/desktop-failure.png'}).catch(()=>{});}
  throw error;
} finally { await desktop.close(); await rm(root,{recursive:true,force:true}); }
