// Verifica la correccion: saltos de linea/parrafos del PDF + limites de carga.
// Fase 0: la carga de archivos vive en la pestaña de trabajo (input[type=file] oculto en la
// sección de entrada); los avisos son diálogos propios [role=alertdialog] en vez de alert().
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
    if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails?.exception?.description).slice(0, 200));
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + String(r.result.exceptionDetails.text).slice(0, 200);
    return r.result?.result?.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // input de archivo de la sección de entrada (el de Recuperar tiene aria-label 'Seleccionar archivo de llave')
  const FILE_INPUT = `document.querySelector('#input-text').closest('section').querySelector('input[type=file]')`;
  const dialogMsg = () => ev(`document.querySelector('[role=alertdialog] #dlg-msg')?.innerText || ''`);
  const acceptDialog = () => ev(`(()=>{const b=[...document.querySelectorAll('[role=alertdialog] button')].find(b=>/Entendido|Continuar/.test(b.textContent));if(!b)return false;b.click();return true})()`);

  const checks = [];
  const check = (n, ok, d) => { checks.push({ n, ok: !!ok, d }); };

  await send('Runtime.enable'); await send('Page.enable');
  errs.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(9000);

  check('la app sigue arrancando tras los cambios', (await ev('document.getElementById("root").children.length')) >= 1);
  check('sin excepciones al cargar', errs.length === 0, errs.join(' | '));
  check('constantes de limite definidas', (await ev('typeof MAX_FILE_MB !== "undefined" ? MAX_FILE_MB : null')) === 25, 'MAX_FILE_MB=' + await ev('typeof MAX_FILE_MB!=="undefined"?MAX_FILE_MB:"?"'));
  check('reconstructPageText existe', (await ev('typeof reconstructPageText')) === 'function');

  // --- limite visible en la UI (pestaña de trabajo, span#file-limits) ---
  await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Anonimizar texto/.test(x.innerText))?.click()`);
  await sleep(1200);
  const zona = String(await ev(`document.querySelector('#file-limits')?.innerText || ''`));
  check('la zona de carga anuncia el limite', /hasta 25 MB y 300 páginas/i.test(zona), zona);
  check('anuncia soporte multipagina (300 páginas)', /300 páginas/.test(zona) && (await ev('typeof MAX_PDF_PAGES!=="undefined"?MAX_PDF_PAGES:null')) === 300, zona);

  // --- PDF con parrafos: la correccion de verdad ---
  const b64 = readFileSync('pruebas/prueba-parrafos.pdf').toString('base64');
  await ev(`(()=>{
    const bin=atob(${JSON.stringify(b64)}); const a=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
    const f=new File([a],'prueba-parrafos.pdf',{type:'application/pdf'});
    const inp=${FILE_INPUT};
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  let chars = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    // El texto extraído se vuelca en #input-text; el pie anuncia 'N caracteres'.
    const r = await ev(`(()=>{const ta=document.querySelector('#input-text');return ta&&/Archivo: prueba-parrafos\\.pdf/.test(document.body.innerText)?ta.value.length:0})()`);
    if (r > 0) { chars = r; break; }
  }
  check('el PDF se carga', chars > 100, 'chars=' + chars);

  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Anonimizar documento/.test(x.innerText)&&!x.disabled);b&&b.click();})()`);
  await sleep(2500);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ver como documento/.test(x.innerText)&&!x.disabled);b&&b.click();})()`);
  await sleep(2500);

  // numero de <p> en la hoja del visor: antes era 1 (todo aplastado)
  const parrafos = await ev(`(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/Documento seudonimizado/.test(x.getAttribute('aria-label')||''));if(!d)return -1;
    const hoja=d.querySelector('.max-w-3xl')||d; return hoja.querySelectorAll('p').length;})()`);
  check('el visor reparte el texto en varios parrafos', parrafos >= 4, 'parrafos=' + parrafos);

  const preservaSaltos = await ev(`(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/Documento seudonimizado/.test(x.getAttribute('aria-label')||''));const m=d&&d.querySelector('mark');if(!m)return false;
    const p=m.closest('p'); return p?getComputedStyle(p).whiteSpace:'(sin p)';})()`);
  check('los parrafos conservan saltos de linea (pre-wrap)', String(preservaSaltos).includes('pre'), 'white-space=' + preservaSaltos);

  const visor = String(await ev('document.body.innerText'));
  check('conserva los titulos en linea propia', /ASISTENTES[\s\S]{0,80}ACUERDOS|ACUERDOS/.test(visor), null);
  check('anonimiza el PDF con parrafos', /\[EMAIL_\d+\]/.test(visor) && /\[ID_FISCAL_\d+\]/.test(visor), null);

  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync('pruebas/evidencia-parrafos.png', Buffer.from(r.result.data, 'base64'));

  // --- limite de tamano: archivo de 30 MB debe rechazarse con diálogo propio ---
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='← Cerrar');b&&b.click();})()`);
  await sleep(300);
  await send('Page.navigate', { url: URL_APP });
  await sleep(8000);
  await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Anonimizar texto/.test(x.innerText))?.click()`);
  await sleep(1200);
  await ev(`window.__nativeAlert=0;window.alert=()=>{window.__nativeAlert++};`);
  await ev(`(()=>{
    const grande=new Uint8Array(30*1024*1024);
    const f=new File([grande],'enorme.pdf',{type:'application/pdf'});
    const inp=${FILE_INPUT};
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  let rechazo = '';
  for (let i = 0; i < 10; i++) { await sleep(500); rechazo = String(await dialogMsg()); if (rechazo) break; }
  const sinNativo = (await ev('window.__nativeAlert')) === 0;
  check('rechaza un archivo de 30 MB con mensaje claro', /máximo admitido es 25 MB/.test(rechazo) && sinNativo, (rechazo || '(sin aviso)').slice(0, 110).replace(/\n/g, ' ') + (sinNativo ? '' : ' | usó alert nativo'));
  await acceptDialog(); await sleep(200);
  check('el aviso se cierra con su botón y no deja texto cargado', await ev(`!document.querySelector('[role=alertdialog]') && document.querySelector('#input-text').value===''`));

  const fail = checks.filter(c => !c.ok);
  console.log('\n=== CORRECCION: SALTOS DE LINEA + LIMITES ===');
  for (const c of checks) console.log((c.ok ? '  OK  ' : ' FALLA') + ' | ' + c.n + (c.d ? '  -> ' + c.d : ''));
  console.log('\nTOTAL: ' + checks.length + ' | OK: ' + (checks.length - fail.length) + ' | FALLAS: ' + fail.length);
  ws.close();
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(2); });
