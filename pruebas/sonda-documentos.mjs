import {writeFileSync,mkdirSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
const list=await(await fetch('http://127.0.0.1:9334/json/list')).json();const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r));let id=0;const pending=new Map(),errors=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
const send=(method,params={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async expression=>{const m=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(m.result.exceptionDetails)throw Error(m.result.exceptionDetails.exception?.description||'eval');return m.result.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));const until=async(expression,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await ev(expression))return true;await pause(150);}return false;};
let ok=0,fail=0;const check=(n,b)=>{b?ok++:fail++;console.log((b?'✔ ':'✖ ')+n);};
const tab=async n=>{await ev(`[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes(${JSON.stringify(n)})).click()`);await pause(200);};
const click=async label=>{const b=await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>!b.closest('[hidden]')&&b.textContent.replace(/^[^\\p{L}\\p{N}]+/u,'').replace(/\\s+/g,' ').trim()===${JSON.stringify(label.replace(/^[^\p{L}\p{N}]+/u,'').replace(/\s+/g,' ').trim())});if(!b||b.disabled)return false;b.click();return true})()`);await pause(200);return b;};
const fill=async(sel,text)=>{await ev(`(()=>{const t=document.querySelector(${JSON.stringify(sel)});Object.getOwnPropertyDescriptor(t.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event(t.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);await pause(200);};
const upload=async(sel,file)=>{const m=await send('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(sel)})`});if(!m.result.result.objectId)throw Error('No existe '+sel);await send('DOM.setFileInputFiles',{objectId:m.result.result.objectId,files:[file]});await pause(250);};
try{
await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1366,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:'http://127.0.0.1:5199/?files='+Date.now()});await pause(5000);await tab('Anonimizar texto');
check('aclaración visible: solo texto, no diseño gráfico',await ev(`/trabaja con el texto de tu documento/i.test(document.body.innerText)&&/imágenes.*gráficos/i.test(document.body.innerText)`));
await fill('#input-text','Cliente: Ana Ruiz. Correo ana@ejemplo.test.');await click('Anonimizar documento');
check('descarga multiformato visible junto al resultado',await ev(`!!document.querySelector('[data-document-download="anonymized"]')`));
check('descarga bloqueada antes de confirmar revisión',await ev(`document.querySelector('[data-document-download="anonymized"] button')?.disabled===true`));
check('selector ofrece Word PDF TXT JSON',await ev(`(()=>{const s=document.querySelector('[data-document-download="anonymized"] select');return s&&JSON.stringify([...s.options].map(o=>o.value))===JSON.stringify(['docx','pdf','txt','json'])})()`));
await tab('Restaurar datos originales');
check('restauración acepta cargar el documento completo, además de la llave',await ev(`!!document.querySelector('input[type=file][aria-label="Seleccionar documento con etiquetas"]')`));
check('sin excepciones de runtime',errors.length===0);
}finally{await send('Emulation.clearDeviceMetricsOverride');ws.close();}
console.log(`TOTAL: ${ok+fail} | OK: ${ok} | FALLAS: ${fail}`);if(fail)process.exitCode=1;
