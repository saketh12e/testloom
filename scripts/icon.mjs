import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});
await page.setContent('<style>html,body{margin:0;background:transparent}</style>'+await readFile('assets/icon.svg','utf8'));
await page.screenshot({path:'assets/icon.png',omitBackground:true});
await browser.close();
if(process.platform==='darwin'){
  await mkdir('work/JourneyProof.iconset',{recursive:true});
  for(const size of [16,32,128,256,512]) for(const scale of [1,2]) execFileSync('sips',['-z',String(size*scale),String(size*scale),'assets/icon.png','--out',`work/JourneyProof.iconset/icon_${size}x${size}${scale===2?'@2x':''}.png`],{stdio:'ignore'});
  execFileSync('iconutil',['-c','icns','work/JourneyProof.iconset','-o','assets/icon.icns']);
}
