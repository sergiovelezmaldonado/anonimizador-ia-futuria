// Sonda de seguridad y privacidad (Fase 0): control de exportación, descargas, portapapeles,
// visor, recuperación, borrado de sesión, red y almacenamiento. Adaptada a la interfaz nueva:
// una pestaña de trabajo ('🔒 Anonimizar texto'), diálogos propios [role=alertdialog] en lugar de
// alert()/confirm() nativos, e impresión mediante <iframe> oculto (no window.open).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const targets = await (await fetch('http://127.0.0.1:9334/json/list')).json();
const target = targets.find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const requests = [], errors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({id:i, method, params})); });
const ev = async expression => { const m = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true, userGesture:true}); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text); return m.result?.result?.value; };
const pause = ms => new Promise(r => setTimeout(r, ms));
// Botón accionable por texto exacto (fuera de los diálogos propios).
const click = async label => { const ok = await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>!b.closest('[role=alertdialog]')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`); assert.ok(ok, 'botón accionable: '+label); await pause(150); };
const tab = async name => { const ok = await ev(`(()=>{const b=[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes(${JSON.stringify(name)}));if(!b)return false;b.click();return true})()`); assert.ok(ok, 'pestaña: '+name); await pause(400); };
const fill = async (selector, value) => { assert.ok(await ev(`(()=>{const t=document.querySelector(${JSON.stringify(selector)});if(!t)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(value)});t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`), selector); await pause(150); };
// Diálogos propios: leer el mensaje y pulsar un botón por texto.
const dialogMsg = () => ev(`document.querySelector('[role=alertdialog] #dlg-msg')?.innerText || ''`);
const dialogButton = async label => { const ok = await ev(`(()=>{const b=[...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`); assert.ok(ok, 'botón del diálogo: '+label); await pause(200); };
const waitDialog = async () => { for (let n = 0; n < 20; n++) { if (await ev(`!!document.querySelector('[role=alertdialog]')`)) return true; await pause(100); } return false; };
// Casilla de revisión: la del visor cuando está abierto (el fondo queda inerte), si no la del resultado.
const REVIEW = `(document.querySelector('[role=dialog][aria-label^="Documento seudonimizado"] input[data-review]')||document.querySelector('input[data-review]'))`;
const FILE_INPUT = `document.querySelector('#input-text').closest('section').querySelector('input[type=file]')`;
const uploadText = async (content, name) => { await ev(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:'text/plain'}));const input=${FILE_INPUT};input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`); for (let n = 0; n < 30; n++) { if (await ev(`document.querySelector('#input-text').value.length>0 && /Archivo: /.test(document.body.innerText)`)) break; await pause(100); } await pause(150); };
const checks=[];
const check=(name, ok)=>{checks.push({name,ok:!!ok}); console.log((ok?'OK ':'FALLA ')+name);};
try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  // Runtime.enable puede repetir excepciones de una prueba anterior. Medir desde esta navegación.
  errors.length=0; requests.length=0;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate',{url:'http://localhost:5199/'});
  for(let n=0;n<80;n++){if(await ev('!!document.querySelector("#input-text")'))break;await pause(250);}
  // Los diálogos nativos no deben usarse: si alguno se invoca, queda registrado.
  await ev(`window.__native={alert:0,confirm:0};window.alert=()=>{window.__native.alert++};window.confirm=()=>{window.__native.confirm++;return true};`);
  await tab('Anonimizar texto');
  await fill('#input-text','Paciente: María García. Correo: maria@ejemplo.test.');
  await click('Ocultar datos sensibles'); await pause(300);
  check('sin falso porcentaje de riesgo', !/riesgo residual:\s*\d+%/i.test(await ev('document.body.innerText')));
  check('copiar bloqueado antes de revisión manual', await ev(`([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Copiar para pegar en la IA'))||{}).disabled===true && ([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Copiar solo el texto'))||{}).disabled===true`));
  check('checkbox de revisión disponible', await ev('!!document.querySelector("input[data-review]")'));
  await click('Ver como documento'); await pause(400);
  check('imprimir también bloqueado antes de revisión', await ev(`([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Imprimir'))||{}).disabled===true`));
  await send('Emulation.setEmulatedMedia',{media:'print'});
  check('Ctrl+P no imprime el visor sin pasar por el control de exportación', await ev(`getComputedStyle(document.querySelector('[role="dialog"][aria-label^="Documento seudonimizado"]')).display==='none'`));
  await send('Emulation.setEmulatedMedia',{media:''});
  await click('← Cerrar'); await pause(200);
  await ev(`${REVIEW}.click()`); await pause(150);
  check('copiar se habilita solo tras revisión', await ev(`([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Copiar para pegar en la IA'))||{}).disabled===false`));
  await ev(`window.__blobs=[];window.__savedNames=[];const original=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__blobs.push(b);return original(b)};HTMLAnchorElement.prototype.click=function(){window.__savedNames.push(this.download)};`);
  await click('Descargar .txt'); await pause(200);
  const txt = await ev('window.__blobs[0].text()');
  check('descarga normal sin mapa ni originales', !!txt && !txt.includes('María García') && !txt.includes('maria@ejemplo.test') && txt.includes('[EMAIL_'));
  check('descarga normal es TXT', await ev('window.__savedNames[0].endsWith(".txt")'));
  await click('Descargar Word con los originales'); await waitDialog();
  const backupMsg = await dialogMsg();
  check('respaldo requiere confirmación de sensibilidad', /original|confidencial/i.test(backupMsg) && await ev(`!!document.querySelector('[role=alertdialog]')`));
  await dialogButton('Cancelar');
  check('cancelar respaldo no genera archivo', await ev('window.__blobs.length===1'));
  await click('Descargar Word con los originales'); await waitDialog(); await dialogButton('Descargar respaldo'); await pause(400);
  const backup = await ev('window.__blobs[1].text()');
  check('respaldo explícito conserva originales para recuperación', backup.includes('María García') && backup.includes('maria@ejemplo.test'));
  check('respaldo no inventa porcentaje de riesgo', !/riesgo residual:.*?\d+%/i.test(backup));
  await ev('navigator.clipboard.writeText=()=>Promise.reject(new Error("permiso denegado"));');
  await click('Copiar para pegar en la IA'); await waitDialog();
  const clipMsg = await dialogMsg();
  check('fallo del portapapeles se explica sin excepción', /copiar|portapapeles/i.test(clipMsg) && errors.length===0);
  await dialogButton('Entendido');
  await click('Copiar llave'); await waitDialog();
  check('copiar mapa advierte que contiene originales', /original|confidencial/i.test(await dialogMsg()));
  await dialogButton('Cancelar');
  await fill('#input-text','Otro texto de ejemplo.'); await click('Ocultar datos sensibles'); await pause(300);
  check('nuevo resultado invalida revisión anterior', await ev('!document.querySelector("input[data-review]").checked'));
  // Documento: misma pestaña de trabajo, carga de archivo + procesar + visor
  await uploadText('Paciente: Lucía Torres. Correo: lucia@ejemplo.test.','expediente-Lucia-Torres.txt');
  await click('Ocultar datos sensibles'); await pause(300);
  await click('Ver como documento'); await pause(400);
  check('Documento también exige revisión', await ev(`${REVIEW}?.checked===false && [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Imprimir')).disabled`));
  await ev(`${REVIEW}.click()`); await pause(150);
  check('visor aísla el fondo de la interacción', await ev('document.getElementById("root").inert===true'));
  // Reprocesamiento con salida idéntica: la revisión debe invalidarse.
  await click('← Cerrar'); await pause(200);
  await uploadText('Paciente: Nuria Ramos. Correo: nuria@ejemplo.test.','expediente-Nuria-Ramos.txt');
  await click('Ocultar datos sensibles'); await pause(300);
  await click('Ver como documento'); await pause(400);
  check('nuevo Documento invalida revisión aunque genere las mismas etiquetas', await ev(`${REVIEW}.checked===false`));
  await ev(`(()=>{const c=${REVIEW};if(!c.checked)c.click()})()`); await pause(150);
  // Impresión: iframe oculto con srcdoc. Se captura el HTML y se neutraliza print() dentro del marco.
  await ev(`(()=>{window.__printHtml=null;window.__printed=false;const d=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'srcdoc');Object.defineProperty(HTMLIFrameElement.prototype,'srcdoc',{configurable:true,get(){return d.get.call(this)},set(v){window.__printHtml=v;d.set.call(this,String(v).replace('<head>','<head><script>window.print=function(){parent.__printed=true}</script>'))}});})()`);
  await click('🖨 Imprimir / Guardar PDF'); await pause(1200);
  const printed = await ev(`window.__printHtml?new DOMParser().parseFromString(window.__printHtml,'text/html').body.textContent:null`);
  check('impresión mediante marco oculto sin ventana emergente', await ev('window.__printed===true && !!document.querySelector("iframe[aria-hidden=true]")'));
  check('HTML de impresión sin originales ni nombre del archivo', !!printed && printed.includes('[PERSONA_1]') && !printed.includes('Nuria Ramos') && !printed.includes('nuria@ejemplo.test') && !printed.includes('expediente-Nuria-Ramos.txt'));
  await click('← Cerrar'); await pause(200);
  await tab('Recuperar');
  check('Documento comparte el mapa con Recuperar', await ev('/etiquetas de tu último texto/i.test(document.body.innerText)'));
  await fill('#modified-text','Respuesta: [PERSONA_1] y [EMAIL_1].'); await click('Recuperar datos originales'); await pause(200);
  check('recuperación de Documento restituye nombres y correos', await ev('document.body.innerText.includes("Nuria Ramos") && document.body.innerText.includes("nuria@ejemplo.test")'));
  await tab('Anonimizar texto');
  await fill('#input-text','Paciente: María\tGarcía.'); await click('Ocultar datos sensibles'); await pause(300);
  await ev('navigator.clipboard.writeText=text=>{window.__mapCopied=text;return Promise.resolve()}');
  await click('Copiar llave'); await waitDialog(); await dialogButton('Copiar llave'); await pause(300);
  const copiedMap=await ev('window.__mapCopied');
  check('copia del mapa usa original JSON sin tabulaciones crudas', /Original \(JSON\)/.test(copiedMap) && copiedMap.includes('María\\tGarcía'));
  await tab('Recuperar');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Usar una llave guardada')).click()`); await pause(200);
  await fill('#mapping-text',copiedMap);
  await fill('#modified-text','Dato: [PERSONA_1]'); await click('Recuperar datos originales'); await pause(200);
  check('copiar y pegar mapa en interfaz recupera tabulación exacta', await ev('document.querySelector("pre")?.textContent===\'Dato: María\\tGarcía\''));
  await fill('#mapping-text','Etiqueta\tOriginal (JSON)\n[PERSONA_1]\tJSON_INVALIDO');
  await click('Recuperar datos originales'); await waitDialog();
  check('mapa mal formado genera aviso y no excepción', /JSON inválido/i.test(await dialogMsg()) && errors.length===0);
  await dialogButton('Entendido');
  await tab('Privacidad');
  const privacy = await ev('document.body.innerText');
  check('privacidad sin promesas de borrado absoluto', !/sin rastros|privacidad garantizada/i.test(privacy));
  check('privacidad explica descargas y portapapeles', /portapapeles/i.test(privacy) && /descargas/i.test(privacy));
  await click('Borrar sesión'); await waitDialog(); await dialogButton('Borrar sesión'); await pause(300);
  await tab('Recuperar');
  check('borrar sesión elimina el mapa de recuperación', await ev('/Todavía no has ocultado nada|Todavía no has procesado nada|no hay|anonimiza primero/i.test(document.body.innerText) && !/etiquetas de tu último texto/i.test(document.body.innerText)'));
  check('ningún alert()/confirm() nativo en todo el flujo', await ev('window.__native.alert===0 && window.__native.confirm===0'));
  const pdf64 = readFileSync(new URL('prueba-multipagina.pdf', import.meta.url)).toString('base64');
  await ev(`(async()=>{await loadPdfJs();const real=window.pdfjsLib.getDocument;window.pdfjsLib={...window.pdfjsLib,getDocument(options){window.__pdfEval=options.isEvalSupported;const task=real(options);task.promise.then(pdf=>{const destroy=pdf.destroy.bind(pdf);pdf.destroy=()=>{window.__pdfDestroyed=true;return destroy()}});return task}};window.__extracted=await extractTextFromFile(new File([Uint8Array.from(atob(${JSON.stringify(pdf64)}),c=>c.charCodeAt(0))],'demo.pdf'),()=>{});})()`);
  check('PDF multipágina se extrae con motor real', await ev('window.__extracted.includes("MARCADOR_PAGINA_012")'));
  check('evaluación de código PDF deshabilitada', await ev('window.__pdfEval===false'));
  check('PDF libera recursos tras extraer texto', await ev('window.__pdfDestroyed===true'));
  check('sin almacenamiento de documentos en APIs del navegador', await ev('(async()=>localStorage.length===0 && sessionStorage.length===0 && document.cookie===\'\' && (await indexedDB.databases()).length===0 && (await caches.keys()).length===0)()'));
  const allowed=['localhost:5199','127.0.0.1:5199','unpkg.com','cdn.tailwindcss.com','fonts.googleapis.com','fonts.gstatic.com'];
  const unexpected=requests.filter(r=>{try{return !['blob:','data:','about:'].includes(new URL(r.url).protocol) && (!allowed.includes(new URL(r.url).host) || r.method!=='GET');}catch{return true;}});
  check('sin subidas de documentos ni destinos externos no previstos', unexpected.length===0);
  check('contenido de documentos ausente de peticiones HTTP', requests.every(r=>!/(maria@ejemplo|Lucía Torres|lucia@ejemplo|Nuria Ramos)/i.test(r.url+' '+(r.postData||''))));
  await send('Page.reload',{ignoreCache:true}); await pause(500);
  for(let n=0;n<80;n++){if(await ev('!!document.querySelector("#input-text")'))break;await pause(250);}
  await tab('Recuperar');
  check('recarga no restaura documentos ni equivalencias', await ev('!/etiquetas de la última sustitución/i.test(document.body.innerText)'));
  check('sin excepciones de página',errors.length===0);
  if (errors.length) console.log('excepciones: ' + errors.slice(0, 3).join(' | '));
  if (unexpected.length) console.log('peticiones inesperadas: ' + unexpected.slice(0, 5).map(r => r.method + ' ' + r.url).join(' | '));
  const report={date:new Date().toISOString(),total:checks.length,passed:checks.filter(c=>c.ok).length,checks,errors};
  writeFileSync(new URL('resultado-seguridad.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  console.log('TOTAL: ' + report.total + ' | OK: ' + report.passed + ' | FALLAS: ' + (report.total - report.passed));
  assert.ok(checks.every(c=>c.ok),'fallaron controles de seguridad');
} finally {ws.close();}
