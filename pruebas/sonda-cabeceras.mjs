// Solo estilos de los bloques introductorios; pestaña CDP aislada.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))), captures=path.join(root,'pruebas/capturas-cabeceras');fs.mkdirSync(captures,{recursive:true});
const target=await(await fetch('http://127.0.0.1:9334/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r));let id=0;const pending=new Map(),errors=[],checks=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);pending.delete(m.id);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
const send=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id,timer=setTimeout(()=>{pending.delete(seq);reject(Error('Tiempo agotado: '+method));},25000);pending.set(seq,{resolve,reject,timer});ws.send(JSON.stringify({id:seq,method,params}));});
const ev=async expression=>{const m=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(m.exceptionDetails)throw Error(m.exceptionDetails.exception?.description||m.exceptionDetails.text);return m.result.value;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async expression=>{const end=Date.now()+25000;while(Date.now()<end){if(await ev(expression))return;await wait(100);}throw Error(expression);};
const check=(name,ok)=>{checks.push({name,ok:!!ok});console.log((ok?'✔ ':'✖ ')+name);};
const tabs=[['Cómo usar','Por qué anonimizar antes de usar una IA','como-usar'],['Ajustes','Decide qué información quieres ocultar','ajustes'],['Anonimizar texto','Pásalo por aquí antes de pegarlo en una IA','anonimizar'],['Restaurar datos originales','Restaura los datos originales en la respuesta de la IA','restaurar']];
try{
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:5199/?cabeceras='+Date.now()});await until(`!!document.querySelector('#why-title')`);
 check('Cómo usar sigue siendo la pestaña inicial',await ev(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Cómo usar')`));
 for(const width of [1366,360]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===360});
  for(const [tab,title,slug] of tabs){
   await ev(`[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes(${JSON.stringify(tab)})).click()`);await wait(150);await ev(`window.scrollTo(0,0)`);
   const data=await ev(`(()=>{const h=[...document.querySelectorAll('h2')].find(h=>!h.closest('[hidden]')&&h.textContent===${JSON.stringify(title)});if(!h)return null;const box=h.closest('section')||h.parentElement,r=h.getBoundingClientRect(),b=box.getBoundingClientRect();return {color:getComputedStyle(box).backgroundColor,visible:r.width>0&&r.top>=b.top&&r.bottom<=b.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1};})()`);
   check(tab+' · fondo rojo suave '+width,data?.color==='rgb(255, 245, 246)');
   check(tab+' · título dentro del bloque '+width,!!data?.visible);
   check(tab+' · sin desborde de página '+width,data?.overflow===false);
   const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const bytes=Buffer.from(shot.data,'base64');fs.writeFileSync(path.join(captures,slug+'-'+width+'.png'),bytes);console.log('CAPTURA '+slug+'-'+width+' '+createHash('sha256').update(bytes).digest('hex'));
  }
 }
 check('sin excepciones de ejecución',errors.length===0);
}finally{ws.close();await fetch('http://127.0.0.1:9334/json/close/'+target.id);}
const result={date:new Date().toISOString(),appSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'index.html'))).digest('hex'),checks,total:checks.length,passed:checks.filter(x=>x.ok).length};fs.writeFileSync(path.join(captures,'resultado.json'),JSON.stringify(result,null,2));
console.log(`TOTAL: ${result.total} | OK: ${result.passed} | FALLAS: ${result.total-result.passed}`);if(result.passed!==result.total)process.exitCode=1;
