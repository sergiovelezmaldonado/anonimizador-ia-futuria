// Verifica: (1) el .doc legado da un mensaje util en español en vez del error
// tecnico de mammoth, (2) el .docx sigue funcionando, (3) el visor de documento
// se abre desde el resultado de la pestaña de trabajo ('🔎 Ver como documento').
// Fase 0: la carga vive en la pestaña '🔒 Anonimizar texto'; los avisos son
// diálogos propios [role=alertdialog] (#dlg-msg) en lugar de alert().
const CDP = 'http://127.0.0.1:9334';
const URL_APP = 'http://localhost:5199/';
import { readFileSync, writeFileSync } from 'node:fs';

async function main() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errs = [];
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails?.exception?.description).slice(0, 220));
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + String(r.result.exceptionDetails.text).slice(0, 160);
    return r.result?.result?.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });
  const FILE_INPUT = `document.querySelector('#input-text').closest('section').querySelector('input[type=file]')`;
  const dialogMsg = () => ev(`document.querySelector('[role=alertdialog] #dlg-msg')?.innerText || ''`);
  const acceptDialog = () => ev(`(()=>{const b=[...document.querySelectorAll('[role=alertdialog] button')].find(b=>/Entendido|Continuar/.test(b.textContent));if(!b)return false;b.click();return true})()`);

  await send('Runtime.enable'); await send('Page.enable');
  errs.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });

  async function irATrabajo() {
    await send('Page.navigate', { url: URL_APP });
    await sleep(8500);
    await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Anonimizar texto/.test(x.innerText))?.click()`);
    await sleep(1200);
    await ev(`window.__nativeAlert=0;window.alert=()=>{window.__nativeAlert++};`);
  }

  async function subirDoc(archivo, nombre) {
    await irATrabajo();
    const b64 = readFileSync(archivo).toString('base64');
    await ev(`(()=>{
      const bin=atob(${JSON.stringify(b64)}); const a=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
      const f=new File([a],${JSON.stringify(nombre)});
      const inp=${FILE_INPUT};
      const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    for (let i = 0; i < 20; i++) {
      await sleep(1100);
      const chars = await ev(`(()=>{const ta=document.querySelector('#input-text');return ta&&new RegExp('Archivo: '+${JSON.stringify(nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}).test(document.body.innerText)?ta.value.length:0})()`);
      const al = String(await dialogMsg());
      if (chars > 0) return { chars, aviso: null };
      if (al) { await acceptDialog(); return { chars: null, aviso: al }; }
    }
    return { chars: null, aviso: null };
  }

  // --- 1) .doc legado real ---
  const legado = await subirDoc('pruebas/prueba-legado.doc', 'prueba-legado.doc');
  console.log('.doc legado ->', JSON.stringify(legado).slice(0, 300));
  const av = String(legado.aviso || '');
  check('el .doc legado se rechaza con aviso', !!legado.aviso, null);
  check('el aviso es un diálogo propio, no alert() nativo', (await ev('window.__nativeAlert')) === 0, null);
  check('el aviso está en español, no es el error de mammoth', !/Could not find the body element/.test(av), null);
  check('el aviso identifica el formato antiguo de Word', /formato antiguo de Word \(97-2003\)/.test(av), null);
  check('el aviso explica cómo resolverlo (Guardar como .docx)', /Guardar como/.test(av) && /docx/.test(av), null);
  check('el aviso ofrece la alternativa de pegar el texto', /pega el texto|copia y pega/i.test(av), null);

  // --- 2) .docx de control: no se rompió nada ---
  const moderno = await subirDoc('pruebas/prueba-moderno.docx', 'prueba-moderno.docx');
  console.log('.docx moderno ->', JSON.stringify(moderno).slice(0, 200));
  check('el .docx sigue extrayéndose', moderno.chars > 50, 'chars=' + moderno.chars);
  check('el .docx no genera aviso de error', !moderno.aviso, moderno.aviso ? String(moderno.aviso).slice(0, 80) : null);

  // --- 3) un archivo renombrado (txt con extension .docx) ---
  await irATrabajo();
  await ev(`(()=>{
    const f=new File([new TextEncoder().encode('esto no es un docx')],'falso.docx');
    const inp=${FILE_INPUT};
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  let renombrado = '';
  for (let i = 0; i < 12; i++) { await sleep(500); renombrado = String(await dialogMsg()); if (renombrado) break; }
  check('un archivo renombrado a .docx se detecta', /no parece un documento de Word válido/.test(renombrado), (renombrado || '(sin aviso)').slice(0, 90).replace(/\n/g, ' '));
  await acceptDialog(); await sleep(200);

  // --- 4) visor desde el texto pegado (misma pestaña de trabajo) ---
  await irATrabajo();
  await ev(`(()=>{const ta=document.querySelector('#input-text');
    const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(ta,'Contacto maria.lopez@acmecorp.com, telefono +52 55 1234 5678, RFC GODE561231GR8, IP 192.168.14.22');
    ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(1000);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ocultar datos sensibles/.test(x.innerText.trim())&&!x.disabled);b&&b.click();})()`);
  await sleep(2500);

  const hayBoton = await ev(`(()=>!!Array.from(document.querySelectorAll('button')).find(x=>/Ver como documento/i.test(x.innerText)))()`);
  check('el resultado del texto pegado ofrece "🔎 Ver como documento"', hayBoton, null);

  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ver como documento/i.test(x.innerText));b&&b.click();})()`);
  await sleep(2200);
  const vis = String(await ev('document.body.innerText'));
  const visorAbierto = await ev(`!![...document.querySelectorAll('[role=dialog]')].find(x=>/^Documento seudonimizado/.test(x.getAttribute('aria-label')||''))`);
  check('el visor se abre desde el texto pegado', visorAbierto && /Con marcas|Sin marcas/i.test(vis), null);
  check('el visor muestra el contenido anonimizado', /\[EMAIL_\d+\]/.test(vis) && (await ev(`[...document.querySelectorAll('[role=dialog]')].find(x=>/^Documento seudonimizado/.test(x.getAttribute('aria-label')||''))?.querySelectorAll('mark').length`)) > 0, null);
  check('el visor ofrece imprimir, texto sin mapa y respaldo separado', /Imprimir \/ Guardar PDF/i.test(vis) && /Descargar texto \.txt/i.test(vis) && /Respaldo confidencial \.doc/i.test(vis), null);
  check('sin excepciones en toda la prueba', errs.length === 0, errs.join(' | '));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync('pruebas/evidencia-visor-desde-texto.png', Buffer.from(r.result.data, 'base64'));
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='← Cerrar');b&&b.click();})()`);

  const fail = checks.filter(c => !c.ok);
  console.log('\n=== .DOC LEGADO + VISOR DESDE TEXTO ===');
  for (const c of checks) console.log((c.ok ? '  OK  ' : ' FALLA') + ' | ' + c.n + (c.d ? '  -> ' + c.d : ''));
  console.log('\nTOTAL: ' + checks.length + ' | OK: ' + (checks.length - fail.length) + ' | FALLAS: ' + fail.length);
  ws.close();
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(2); });
