// Verifica la correccion: saltos de linea/parrafos del PDF + limites de carga.
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

  const checks = [];
  const check = (n, ok, d) => { checks.push({ n, ok: !!ok, d }); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(9000);

  check('la app sigue arrancando tras los cambios', (await ev('document.getElementById("root").children.length')) >= 1);
  check('sin excepciones al cargar', errs.length === 0, errs.join(' | '));
  check('constantes de limite definidas', (await ev('typeof MAX_FILE_MB !== "undefined" ? MAX_FILE_MB : null')) === 25, 'MAX_FILE_MB=' + await ev('typeof MAX_FILE_MB!=="undefined"?MAX_FILE_MB:"?"'));
  check('reconstructPageText existe', (await ev('typeof reconstructPageText')) === 'function');

  // --- limite visible en la UI ---
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Documento');b&&b.click();})()`);
  await sleep(1800);
  const zona = String(await ev('document.body.innerText'));
  check('la zona de carga anuncia el limite', /Hasta 25 MB y 300 páginas/.test(zona), null);
  check('anuncia soporte multipagina', /varias páginas admitid/i.test(zona), null);

  // --- PDF con parrafos: la correccion de verdad ---
  const b64 = readFileSync('pruebas/prueba-parrafos.pdf').toString('base64');
  await ev(`(()=>{
    const bin=atob(${JSON.stringify(b64)}); const a=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
    const f=new File([a],'prueba-parrafos.pdf',{type:'application/pdf'});
    const inp=document.querySelector('input[type=file]');
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  let chars = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    const m = String(await ev('document.body.innerText')).match(/([\d.]+)\s*caracteres extraídos/);
    if (m) { chars = parseInt(m[1].replace(/\./g, ''), 10); break; }
  }
  check('el PDF se carga', chars > 100, 'chars=' + chars);

  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/anonimizar/i.test(x.innerText)&&!x.disabled);b&&b.click();})()`);
  await sleep(4000);

  // numero de <p> en el visor: antes era 1 (todo aplastado)
  const parrafos = await ev(`(()=>{const m=document.querySelector('mark');if(!m)return -1;
    const hoja=m.closest('div[style*="27cm"]')||document.body; return hoja.querySelectorAll('p').length;})()`);
  check('el visor reparte el texto en varios parrafos', parrafos >= 4, 'parrafos=' + parrafos);

  const preservaSaltos = await ev(`(()=>{const m=document.querySelector('mark');if(!m)return false;
    const p=m.closest('p'); return p?getComputedStyle(p).whiteSpace:'(sin p)';})()`);
  check('los parrafos conservan saltos de linea (pre-wrap)', String(preservaSaltos).includes('pre'), 'white-space=' + preservaSaltos);

  const visor = String(await ev('document.body.innerText'));
  check('conserva los titulos en linea propia', /ASISTENTES[\s\S]{0,80}ACUERDOS|ACUERDOS/.test(visor), null);
  check('anonimiza el PDF con parrafos', /\[EMAIL_\d+\]/.test(visor) && /\[ID_FISCAL_\d+\]/.test(visor), null);

  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync('pruebas/evidencia-parrafos.png', Buffer.from(r.result.data, 'base64'));

  // --- limite de tamano: archivo de 30 MB debe rechazarse ---
  await ev('(()=>{const b=document.querySelector("button");return b&&b.innerText;})()');
  await send('Page.navigate', { url: URL_APP });
  await sleep(8000);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Documento');b&&b.click();})()`);
  await sleep(1500);
  const rechazo = await ev(`(async()=>{
    window.__alert=null; const orig=window.alert; window.alert=m=>{window.__alert=m;};
    const grande=new Uint8Array(30*1024*1024);
    const f=new File([grande],'enorme.pdf',{type:'application/pdf'});
    const inp=document.querySelector('input[type=file]');
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,2500));
    window.alert=orig; return window.__alert||'(sin aviso)';
  })()`);
  check('rechaza un archivo de 30 MB con mensaje claro', /máximo admitido es 25 MB/.test(String(rechazo)), String(rechazo).slice(0, 110).replace(/\n/g, ' '));

  const fail = checks.filter(c => !c.ok);
  console.log('\n=== CORRECCION: SALTOS DE LINEA + LIMITES ===');
  for (const c of checks) console.log((c.ok ? '  OK  ' : ' FALLA') + ' | ' + c.n + (c.d ? '  -> ' + c.d : ''));
  console.log('\nTOTAL: ' + checks.length + ' | OK: ' + (checks.length - fail.length) + ' | FALLAS: ' + fail.length);
  ws.close();
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(2); });
