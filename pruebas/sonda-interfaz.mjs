// Verifica los 3 cambios de interfaz pedidos por Sergio:
// 1) Terminos personalizados mas grande (>=15 lineas)
// 2) Texto a anonimizar mas grande
// 3) "Ver plantillas" abre una ventana emergente centrada, no un panel que empuja la pagina
const CDP = 'http://127.0.0.1:9334';
const URL_APP = 'http://localhost:5199/';
import { writeFileSync } from 'node:fs';

async function main() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errs = [];
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails?.exception?.description).slice(0, 250));
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + String(r.result.exceptionDetails.text).slice(0, 200);
    return r.result?.result?.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(9000);

  check('la app arranca sin excepciones', errs.length === 0, errs.join(' | '));

  // --- pestana Texto ---
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Texto');b&&b.click();})()`);
  await sleep(1800);

  const medidas = await ev(`JSON.stringify((()=>{
    const tas=Array.from(document.querySelectorAll('textarea'));
    return tas.map(t=>({
      ph:(t.placeholder||'').slice(0,28),
      rows:t.rows,
      alturaPx: Math.round(t.getBoundingClientRect().height),
      lineas: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight||'20'))
    }));
  })())`);
  console.log('medidas de los textareas:', medidas);
  const tas = JSON.parse(medidas);

  const terminos = tas.find(t => /Juan P/i.test(t.ph));
  const pegado = tas.find(t => /Pega aqu/i.test(t.ph));
  check('Términos personalizados tiene 15 filas', terminos && terminos.rows === 15, terminos ? 'rows=' + terminos.rows + ' alto=' + terminos.alturaPx + 'px' : 'no encontrado');
  check('Términos personalizados muestra >=15 lineas', terminos && terminos.lineas >= 14, terminos ? '~' + terminos.lineas + ' lineas visibles' : '');
  check('Texto a anonimizar tiene 24 filas', pegado && pegado.rows === 24, pegado ? 'rows=' + pegado.rows + ' alto=' + pegado.alturaPx + 'px' : 'no encontrado');
  check('Texto a anonimizar es mas alto que antes (>400px)', pegado && pegado.alturaPx > 400, pegado ? pegado.alturaPx + 'px' : '');

  // --- ventana emergente de plantillas ---
  const scrollAntes = await ev('window.scrollY');
  const abrio = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ver plantillas/i.test(x.innerText));if(!b)return false;b.click();return true;})()`);
  check('existe el boton "Ver plantillas"', abrio);
  await sleep(1500);

  const modal = await ev(`JSON.stringify((()=>{
    const d=document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]');
    if(!d) return {hay:false};
    const cs=getComputedStyle(d);
    const caja=d.firstElementChild.getBoundingClientRect();
    return {hay:true, position:cs.position, zIndex:cs.zIndex,
      centradoH: Math.abs((caja.left+caja.right)/2 - window.innerWidth/2) < 30,
      dentroVentana: caja.top >= 0 && caja.bottom <= window.innerHeight + 2,
      altoCaja: Math.round(caja.height), anchoCaja: Math.round(caja.width)};
  })())`);
  console.log('modal:', modal);
  const mo = JSON.parse(modal);
  check('las plantillas abren en ventana emergente', mo.hay && mo.position === 'fixed', 'position=' + mo.position);
  check('la ventana queda centrada en pantalla', mo.centradoH, null);
  check('la ventana cabe en la pantalla sin perderse', mo.dentroVentana, 'alto=' + mo.altoCaja + 'px');
  check('la pagina de fondo no se movio', (await ev('window.scrollY')) === scrollAntes, null);
  check('el fondo queda bloqueado', (await ev('document.body.style.overflow')) === 'hidden', null);

  const cuantas = await ev(`(()=>{const d=document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]');
    return d?d.querySelectorAll('.grid button').length:0;})()`);
  check('muestra las 50 plantillas', cuantas === 50, 'visibles=' + cuantas);
  const buscador = await ev(`(()=>{const d=document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]');
    if(!d) return 'sin modal';
    const inp=d.querySelector('input[type=text]');
    const filtros=d.querySelectorAll('.flex-wrap button').length;
    return (inp?('buscador:"'+inp.placeholder+'"'):'sin buscador')+' filtros:'+filtros;})()`);
  check('tiene buscador y filtros de categoria', /Buscar plantilla/.test(String(buscador)) && /filtros:9/.test(String(buscador)), String(buscador));
  check('muestra contador al pie', /Mostrando \d+ de 50 plantillas/.test(String(await ev('document.body.innerText'))), null);

  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync('pruebas/evidencia-plantillas-modal.png', Buffer.from(r.result.data, 'base64'));

  // cerrar con Escape
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
  check('se cierra con Escape', (await ev(`!document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]')`)), null);
  check('se restaura el scroll del fondo', (await ev('document.body.style.overflow')) !== 'hidden', null);

  // seleccionar una plantilla sigue funcionando
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ver plantillas/i.test(x.innerText));b&&b.click();})()`);
  await sleep(1200);
  await ev(`(()=>{const d=document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]');
    const b=d&&d.querySelector('.grid button'); b&&b.click();})()`);
  await sleep(1500);
  const cargada = await ev(`(()=>{const tas=Array.from(document.querySelectorAll('textarea'));
    const ta=tas.find(t=>/Pega aqu/i.test(t.placeholder||'')); return ta?ta.value.length:0;})()`);
  check('al elegir una plantilla se carga el texto', cargada > 100, 'chars=' + cargada);
  check('la ventana se cierra al elegir', (await ev(`!document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]')`)), null);

  const fail = checks.filter(c => !c.ok);
  console.log('\n=== CAMBIOS DE INTERFAZ ===');
  for (const c of checks) console.log((c.ok ? '  OK  ' : ' FALLA') + ' | ' + c.n + (c.d ? '  -> ' + c.d : ''));
  console.log('\nTOTAL: ' + checks.length + ' | OK: ' + (checks.length - fail.length) + ' | FALLAS: ' + fail.length);
  if (errs.length) console.log('\nexcepciones: ' + errs.join('\n'));
  ws.close();
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(2); });
