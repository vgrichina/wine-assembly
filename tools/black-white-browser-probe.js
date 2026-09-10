#!/usr/bin/env node
'use strict';
// Diagnostic launch of the genuine extracted demo, with no EXE/capability
// patching. Assets stay outside the repository; no production app registration.
const fs=require('fs'),path=require('path'),http=require('http'),os=require('os');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..');
const game=path.resolve(process.env.BW2_ROOT||'/private/tmp/black-white-full.ntZDCF/extracted/MainApp');
const seconds=Number(process.env.BW2_SECONDS||300);
const output=fs.mkdtempSync(path.join(os.tmpdir(),'black-white-browser-'));
const files=[];
function walk(dir,prefix='') {
  for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const rel=prefix+item.name;
    if(item.isDirectory())walk(path.join(dir,item.name),rel+'/');
    else if(item.isFile())files.push(rel);
  }
}
walk(game);
const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const base=name.startsWith('/game/')?game:root;
  const relative=name.startsWith('/game/')?name.slice(6):name==='/'?'index.html':name.slice(1);
  const file=path.resolve(base,relative);
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cache-Control','no-store');
  if(!file.startsWith(base+path.sep)){res.writeHead(403);res.end();return;}
  fs.stat(file,(error,stat)=>{
    if(error||!stat.isFile()){res.writeHead(404);res.end();return;}
    const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json',
      '.wasm':'application/wasm','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
    res.setHeader('Content-Length',stat.size);
    if(req.method==='HEAD'){res.end();return;}
    const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
  });
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await puppeteer.launch({headless:process.env.BW2_HEADFUL!=='1',
      executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args:['--no-first-run','--no-default-browser-check'],protocolTimeout:120000});
    const page=await browser.newPage();await page.setViewport({width:1100,height:800});
    page.on('console',message=>console.log('[browser]',message.text()));
    page.on('pageerror',error=>console.error('[pageerror]',error.message));
    const query=process.env.BW2_PROGRAMMABLE==='1'?'&d3d9-programmable':'';
    console.log('Artifacts:',output,'assets:',files.length);
    await page.goto(`http://127.0.0.1:${server.address().port}/?debug&perf${query}`,{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>window.wineApps?.APPS && window.wineShell?.launchApp,{timeout:120000});
    await page.evaluate(files=>{
      const traceNames=new Set(['ReadFileEx','OutputDebugStringA','SleepEx']);
      let sleeps=0;
      traceNames.has=name=>Set.prototype.has.call(traceNames,name) && (name!=='SleepEx'||sleeps++<5);
      window.__waTraceApiNames=traceNames;
      const url=rel=>'/game/'+rel.split('/').map(encodeURIComponent).join('/');
      window.wineApps.APPS.black_white_2_probe={exe:url('BW2Demo.exe'),
        dlls:['d3dx9_25.dll','binkw32.dll','dbghelp.dll'].map(url),
        files:files.filter(rel=>rel!=='BW2Demo.exe').map(rel=>({url:url(rel),vfsPath:'c:\\'+rel.replace(/\//g,'\\')})),
        requiredFiles:true};
      window.wineShell.launchApp('black_white_2_probe');
    },files);
    const start=Date.now();let tick=0;
    while(Date.now()-start<seconds*1000) {
      await new Promise(resolve=>setTimeout(resolve,10000));
      const state=await page.evaluate(()=>{
        const shell=window.wineShell,wine=shell.currentWine;
        const ex=wine?.instance?.exports;
        if(ex?.set_count && !wine._bw2Counters) {
          ex.set_count(0,0x00b53100);ex.set_count(1,0x00938961);wine._bw2Counters=true;
        }
        return{status:document.getElementById('status')?.textContent,
          eip:ex?.get_eip?.()>>>0,esi:ex?.get_esi?.()>>>0,
          ioCallbackHits:ex?.get_count?.(0),alertableCallHits:ex?.get_count?.(1),
          ioOverlapped:ex?Array.from({length:5},(_,i)=>ex.guest_read32(0x4fda0300+i*4)>>>0):[],
          windows:Object.values(shell.renderer?.windows||{}).filter(w=>w.visible).map(w=>({
            title:w.title,w:w.w,h:w.h,frame:w._gpuFrameLayer?.writeSeq})),
          log:document.getElementById('log')?.textContent?.slice(-6000),running:!!wine?.running};
      });
      console.log('[state]',JSON.stringify(state));
      if(++tick%3===0)await page.screenshot({path:path.join(output,`frame-${tick}.png`)});
      if(state.windows.some(w=>/Fatal Error/i.test(w.title)) || /UNIMPLEMENTED API|FATAL:|ERROR:/.test(state.log||''))break;
    }
    await page.screenshot({path:path.join(output,'final.png')});
    console.log('Probe finished; screenshots are observations, not a gameplay pass.');
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
