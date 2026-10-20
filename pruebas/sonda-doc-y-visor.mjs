// Verifica: (1) el .doc legado da un mensaje util en español en vez del error
// tecnico de mammoth, (2) el .docx sigue funcionando, (3) el visor de documento
// ya se abre tambien desde la pestana Texto.
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

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });

  async function subirDoc(archivo, nombre) {
    await send('Page.navigate', { url: URL_APP });
    await sleep(8500);
    await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Documento');b&&b.click();})()`);
    await sleep(1600);
    const b64 = readFileSync(archivo).toString('base64');
    await ev(`(()=>{window.__alert=null; window.alert=m=>{window.__alert=m;};})()`);
    await ev(`(()=>{
      const bin=atob(${JSON.stringify(b64)}); const a=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
      const f=new File([a],${JSON.stringify(nombre)});
      const inp=document.querySelector('input[type=file]');
      const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    for (let i = 0; i < 20; i++) {
      await sleep(1100);
      const t = String(await ev('document.body.innerText'));
      const m = t.match(/([\d.]+)\s*caracteres extraídos/);
      const al = await ev('window.__alert');
      if (m) return { chars: parseInt(m[1].replace(/\./g, ''), 10), aviso: null };
      if (al) return { chars: null, aviso: String(al) };
    }
    return { chars: null, aviso: null };
  }

  // --- 1) .doc legado real ---
  const legado = await subirDoc('pruebas/prueba-legado.doc', 'prueba-legado.doc');
  console.log('.doc legado ->', JSON.stringify(legado).slice(0, 300));
  const av = String(legado.aviso || '');
  check('el .doc legado se rechaza con aviso', !!legado.aviso, null);
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
  await send('Page.navigate', { url: URL_APP });
  await sleep(8500);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Documento');b&&b.click();})()`);
  await sleep(1500);
  const renombrado = await ev(`(async()=>{
    window.__alert=null; window.alert=m=>{window.__alert=m;};
    const f=new File([new TextEncoder().encode('esto no es un docx')],'falso.docx');
    const inp=document.querySelector('input[type=file]');
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,4000));
    return window.__alert||'(sin aviso)';
  })()`);
  check('un archivo renombrado a .docx se detecta', /no parece un documento de Word válido/.test(String(renombrado)), String(renombrado).slice(0, 90).replace(/\n/g, ' '));

  // --- 4) visor desde la pestaña Texto ---
  await send('Page.navigate', { url: URL_APP });
  await sleep(8500);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Texto');b&&b.click();})()`);
  await sleep(1600);
  await ev(`(()=>{const tas=Array.from(document.querySelectorAll('textarea'));
    const ta=tas.find(t=>/pega aqu/i.test(t.placeholder||''))||tas[tas.length-1];
    const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(ta,'Contacto maria.lopez@acmecorp.com, telefono +52 55 1234 5678, RFC GODE561231GR8, IP 192.168.14.22');
    ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(1200);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/^🔒 Anonimizar$|anonimizar/i.test(x.innerText.trim())&&!x.disabled);b&&b.click();})()`);
  await sleep(3200);

  const hayBoton = await ev(`(()=>!!Array.from(document.querySelectorAll('button')).find(x=>/Ver como documento/i.test(x.innerText)))()`);
  check('la pestaña Texto ofrece "Ver como documento"', hayBoton, null);

  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ver como documento/i.test(x.innerText));b&&b.click();})()`);
  await sleep(2200);
  const vis = String(await ev('document.body.innerText'));
  check('el visor se abre desde la pestaña Texto', /Con marcas|Sin marcas/i.test(vis), null);
  check('el visor muestra el contenido anonimizado', /\[EMAIL_\d+\]/.test(vis), null);
  check('el visor ofrece imprimir, texto sin mapa y respaldo separado', /Imprimir/i.test(vis) && /Descargar texto \.txt/i.test(vis) && /Respaldo confidencial \.doc/i.test(vis), null);
  check('sin excepciones en toda la prueba', errs.length === 0, errs.join(' | '));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync('pruebas/evidencia-visor-desde-texto.png', Buffer.from(r.result.data, 'base64'));

  const fail = checks.filter(c => !c.ok);
  console.log('\n=== .DOC LEGADO + VISOR DESDE TEXTO ===');
  for (const c of checks) console.log((c.ok ? '  OK  ' : ' FALLA') + ' | ' + c.n + (c.d ? '  -> ' + c.d : ''));
  console.log('\nTOTAL: ' + checks.length + ' | OK: ' + (checks.length - fail.length) + ' | FALLAS: ' + fail.length);
  ws.close();
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(2); });
