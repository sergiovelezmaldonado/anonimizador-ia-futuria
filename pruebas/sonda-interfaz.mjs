// Verifica los 3 cambios de interfaz pedidos por Sergio, adaptados a la Fase 0:
// 1) Terminos personalizados: ya no son 15 filas fijas; es un campo que CRECE al escribir
//    (minimo 3 filas, la altura aumenta al pegar 10 lineas) dentro del panel 'Qué ocultar' (colapsado).
// 2) Texto a anonimizar grande (#input-text, rows=14)
// 3) "📋 Plantillas de ejemplo" abre una ventana emergente centrada, no un panel que empuja la pagina
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
  const setValue = (sel, val) => ev(`(()=>{const t=document.querySelector(${JSON.stringify(sel)});if(!t)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(val)});t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);

  await send('Runtime.enable'); await send('Page.enable');
  errs.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(9000);

  check('la app arranca sin excepciones', errs.length === 0, errs.join(' | '));

  // --- pestaña Ajustes: tipos y palabras propias viven aquí, no en la de trabajo ---
  await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Ajustes$/.test(x.innerText))?.click()`);
  await sleep(800);
  await ev(`document.querySelector('[aria-controls="settings-types"]').click();document.querySelector('[aria-controls="settings-words"]').click()`); await sleep(250);
  check('los campos de palabras propias están visibles al desplegar su bloque', await ev(`['#custom-terms','#whitelist'].every(id=>{const t=document.querySelector(id);return t&&t.offsetParent!==null})`));
  check('el bloque de tipos de datos tiene un título que explica su función', await ev(`/Selecciona qué tipos de datos ocultar/.test(document.querySelector('#cats-title')?.innerText||'')`));
  await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Anonimizar texto/.test(x.innerText))?.click()`);
  await sleep(800);
  check('la pestaña de trabajo no muestra el panel de tipos (sin ruido)', await ev(`!document.querySelector('#cats-title') && !document.querySelector('#custom-terms')`));
  check('la pestaña de trabajo resume los ajustes y enlaza a Ajustes', await ev(`/Se ocultan \\d+ tipos/.test(document.querySelector('[data-settings-summary]')?.innerText||'') && /Cambiar en Ajustes/.test(document.querySelector('[data-settings-summary]')?.innerText||'')`));

  const medir = () => ev(`JSON.stringify((()=>{
    const pick=(sel)=>{const t=document.querySelector(sel);if(!t)return null;return {ph:(t.placeholder||'').slice(0,28),rows:t.rows,alturaPx:Math.round(t.getBoundingClientRect().height),lineas:Math.round(t.getBoundingClientRect().height/parseFloat(getComputedStyle(t).lineHeight||'20'))}};
    return {terminos:pick('#custom-terms'),whitelist:pick('#whitelist'),pegado:pick('#input-text')};
  })())`);
  await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Ajustes$/.test(x.innerText))?.click()`); await sleep(800);
  await ev(`document.querySelector('[aria-controls="settings-words"]').click()`); await sleep(250);
  const antes = JSON.parse(await medir());
  console.log('medidas de los textareas:', JSON.stringify(antes));
  const { terminos, pegado } = antes;

  check('Términos personalizados tiene al menos 3 filas (crece al escribir)', terminos && terminos.rows >= 3, terminos ? 'rows=' + terminos.rows + ' alto=' + terminos.alturaPx + 'px' : 'no encontrado');
  await setValue('#custom-terms', Array.from({ length: 10 }, (_, i) => 'Término ' + (i + 1)).join('\n'));
  await sleep(500);
  const despues = JSON.parse(await medir());
  check('Términos personalizados crece al pegar 10 líneas (>=9 líneas visibles)', despues.terminos && despues.terminos.alturaPx > terminos.alturaPx + 60 && despues.terminos.lineas >= 9,
    despues.terminos ? terminos.alturaPx + 'px -> ' + despues.terminos.alturaPx + 'px (~' + despues.terminos.lineas + ' lineas)' : '');
  await setValue('#custom-terms', ''); await sleep(300);
  await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Anonimizar texto/.test(x.innerText))?.click()`); await sleep(800);
  const pegadoAhora = JSON.parse(await medir()).pegado;
  check('Texto a anonimizar tiene 12 filas', pegadoAhora && pegadoAhora.rows === 12, pegadoAhora ? 'rows=' + pegadoAhora.rows + ' alto=' + pegadoAhora.alturaPx + 'px' : 'no encontrado');
  check('Texto a anonimizar es alto (>250px)', pegadoAhora && pegadoAhora.alturaPx > 250, pegadoAhora ? pegadoAhora.alturaPx + 'px' : '');

  // --- ventana emergente de plantillas ---
  const scrollAntes = await ev('window.scrollY');
  const abrio = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Cargar un ejemplo/i.test(x.innerText));if(!b)return false;b.click();return true;})()`);
  check('existe el boton "Cargar un ejemplo"', abrio);
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

  // seleccionar una plantilla sigue funcionando (sin texto previo no pide confirmación)
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Cargar un ejemplo/i.test(x.innerText));b&&b.click();})()`);
  await sleep(1200);
  await ev(`(()=>{const d=document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]');
    const b=d&&d.querySelector('.grid button'); b&&b.click();})()`);
  await sleep(1500);
  const cargada = await ev(`(()=>{const ta=document.querySelector('#input-text'); return ta?ta.value.length:0;})()`);
  check('al elegir una plantilla se carga el texto', cargada > 100, 'chars=' + cargada);
  check('la ventana se cierra al elegir', (await ev(`!document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]')`)), null);

  // con texto previo, elegir otra plantilla pide confirmación con diálogo propio (Reemplazar)
  await ev(`window.__nativeConfirm=0;window.confirm=()=>{window.__nativeConfirm++;return true}`);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Cargar un ejemplo/i.test(x.innerText));b&&b.click();})()`);
  await sleep(1000);
  await ev(`(()=>{const d=document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]');
    const b=d&&d.querySelectorAll('.grid button')[1]; b&&b.click();})()`);
  await sleep(600);
  check('reemplazar texto existente pide confirmación propia (no confirm nativo)', await ev(`window.__nativeConfirm===0 && !!document.querySelector('[role=alertdialog]') && /Reemplazar/.test(document.querySelector('[role=alertdialog]').innerText)`));
  await ev(`[...document.querySelectorAll('[role=alertdialog] button')].find(b=>/Reemplazar/.test(b.textContent))?.click()`);
  await sleep(600);
  check('tras Reemplazar se carga la nueva plantilla y se cierran los diálogos', await ev(`!document.querySelector('[role=alertdialog]') && !document.querySelector('[role=dialog][aria-label="Plantillas de ejemplo"]') && document.querySelector('#input-text').value.length>100`));

  const fail = checks.filter(c => !c.ok);
  console.log('\n=== CAMBIOS DE INTERFAZ ===');
  for (const c of checks) console.log((c.ok ? '  OK  ' : ' FALLA') + ' | ' + c.n + (c.d ? '  -> ' + c.d : ''));
  console.log('\nTOTAL: ' + checks.length + ' | OK: ' + (checks.length - fail.length) + ' | FALLAS: ' + fail.length);
  if (errs.length) console.log('\nexcepciones: ' + errs.join('\n'));
  ws.close();
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(2); });
