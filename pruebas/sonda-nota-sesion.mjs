// Aviso de guardado visible y semántica real de sesión; pestaña CDP aislada.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dir=path.join(root,'pruebas/capturas-nota-sesion');fs.mkdirSync(dir,{recursive:true});
const target=await(await fetch('http://127.0.0.1:9334/json/new?about:blank',{method:'PUT'})).json();const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r));let seq=0;const jobs=new Map(),errors=[],checks=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=jobs.get(m.id);if(p){clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);jobs.delete(m.id);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{jobs.delete(id);reject(Error(method));},25000);jobs.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;},wait=ms=>new Promise(r=>setTimeout(r,ms));
const ready=async()=>{const end=Date.now()+25000;while(Date.now()<end){if(await ev(`!!document.querySelector('#input-text')`))return;await wait(100);}throw Error('No arrancó la app');};
const tab=async name=>{await ev(`[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`);await wait(150);};
const check=(name,ok)=>{checks.push({name,ok:!!ok});console.log((ok?'✔ ':'✖ ')+name);};
try{
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:5199/?nota-sesion='+Date.now()});await ready();
 for(const width of [1366,360]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===360});for(const [name,slug] of [['Anonimizar texto','anonimizar'],['Restaurar datos originales','restaurar']]){
  await tab(name);await ev('window.scrollTo(0,0)');
  const n=await ev(`(()=>{const list=[...document.querySelectorAll('[data-session-care]')].filter(n=>!n.closest('[hidden]'));if(list.length!==1)return null;const n=list[0],r=n.getBoundingClientRect();return {text:n.textContent,role:n.getAttribute('role'),visible:r.height>0,inside:r.left>=0&&r.right<=innerWidth};})()`);
  check(name+' aviso visible '+width,n?.visible&&n?.role==='note');
  check(name+' explica pérdida al recargar/cerrar '+width,!!n&&/no se guarda automáticamente/i.test(n.text)&&/texto.*resultado.*llave/i.test(n.text)&&/recargar.*cerrar/i.test(n.text));
  check(name+' indica qué guardar y cómo cuidar la llave '+width,!!n&&/documento anonimizado/i.test(n.text)&&/archivos separados/i.test(n.text)&&/no.*envíes.*llave.*IA/i.test(n.text));
  check(name+' distingue descargas y portapapeles '+width,!!n&&/Borrar sesión.*no elimina.*descargas.*portapapeles/i.test(n.text));
  check(name+' sin recorte/desborde '+width,!!n?.inside&&await ev('document.documentElement.scrollWidth<=innerWidth+1'));
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(dir,slug+'-'+width+'.png'),Buffer.from(shot.data,'base64'));
 }}
 await tab('Anonimizar texto');await ev(`(()=>{const t=document.querySelector('#input-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'PRUEBA TEMPORAL DE SESIÓN');t.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(100);await tab('Ajustes');await tab('Anonimizar texto');check('texto temporal sobrevive al cambio de pestañas',await ev(`document.querySelector('#input-text').value==='PRUEBA TEMPORAL DE SESIÓN'`));
 await send('Page.reload',{ignoreCache:true});await wait(500);await ready();await tab('Anonimizar texto');check('recargar inicia sin el texto anterior',await ev(`document.querySelector('#input-text').value===''`));check('sin persistencia en almacenamiento web',await ev(`localStorage.length===0&&sessionStorage.length===0`));check('sin excepciones runtime',errors.length===0);
}finally{ws.close();await fetch('http://127.0.0.1:9334/json/close/'+target.id);}
const report={date:new Date().toISOString(),appSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'index.html'))).digest('hex'),checks,total:checks.length,passed:checks.filter(c=>c.ok).length};fs.writeFileSync(path.join(dir,'resultado.json'),JSON.stringify(report,null,2));console.log(`TOTAL: ${report.total} | OK: ${report.passed} | FALLAS: ${report.total-report.passed}`);if(report.total!==report.passed)process.exitCode=1;
