// Verifica que las 12 paginas del PDF llegan hasta el resultado anonimizado.
// Fase 0: la carga vive en la pestaña de trabajo ('🔒 Ocultar datos'); el texto extraido
// se vuelca en #input-text, se procesa con '🔒 Ocultar datos sensibles' y el visor se abre
// con '🔎 Ver como documento'. Los marcadores se comprueban DENTRO del visor modal.
const CDP = 'http://127.0.0.1:9334';
const URL_APP = 'http://localhost:5199/';
const TOTAL = 12;
import { readFileSync, writeFileSync } from 'node:fs';

async function main() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'EXC';
    return r.result?.result?.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const FILE_INPUT = `document.querySelector('#input-text').closest('section').querySelector('input[type=file]')`;

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(9000);
  await ev(`[...document.querySelectorAll('[role=tab]')].find(x=>/Ocultar datos/.test(x.innerText))?.click()`);
  await sleep(1500);

  const b64 = readFileSync('pruebas/prueba-multipagina.pdf').toString('base64');
  await ev(`(()=>{
    const bin=atob(${JSON.stringify(b64)}); const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const f=new File([arr],'prueba-multipagina.pdf',{type:'application/pdf'});
    const inp=${FILE_INPUT};
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);

  // esperar extraccion: el texto cae en #input-text y el pie indica 'Archivo: prueba-multipagina.pdf'
  let chars = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    const r = await ev(`(()=>{const ta=document.querySelector('#input-text');return ta&&/Archivo: prueba-multipagina\\.pdf/.test(document.body.innerText)?ta.value.length:0})()`);
    if (r > 0) { chars = r; break; }
  }
  console.log('=== EXTRACCION ===');
  console.log('caracteres extraidos del PDF de ' + TOTAL + ' paginas: ' + chars);
  console.log('promedio por pagina: ' + Math.round(chars / TOTAL));

  // anonimizar y abrir el visor modal
  const clic = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ocultar datos sensibles/.test(x.innerText)&&!x.disabled);if(!b)return false;b.click();return true;})()`);
  console.log('boton "Ocultar datos sensibles" accionado: ' + clic);
  await sleep(3000);
  const clicVisor = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/Ver como documento/.test(x.innerText)&&!x.disabled);if(!b)return false;b.click();return true;})()`);
  console.log('boton "Ver como documento" accionado: ' + clicVisor);
  await sleep(3000);

  const visor = String(await ev(`(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/^Documento seudonimizado/.test(x.getAttribute('aria-label')||''));return d?d.innerText:''})()`));
  const enVisor = [];
  for (let i = 1; i <= TOTAL; i++)
    if (visor.includes('MARCADOR_PAGINA_' + String(i).padStart(3, '0'))) enVisor.push(i);

  console.log('\n=== TODAS LAS PAGINAS LLEGAN AL VISOR? ===');
  console.log('marcadores encontrados: ' + enVisor.length + ' de ' + TOTAL + (enVisor.length ? ' -> paginas ' + enVisor.join(',') : ''));
  console.log('visor modal abierto: ' + /Con marcas|Sin marcas/i.test(visor));
  console.log('opcion imprimir: ' + /Imprimir \/ Guardar PDF/i.test(visor));
  console.log('descarga .txt sin mapa y respaldo confidencial .doc: ' + (/Descargar texto \.txt/i.test(visor) && /Respaldo confidencial \.doc/i.test(visor)));

  const cuenta = (re) => (visor.match(re) || []).length;
  console.log('\n=== ANONIMIZACION SOBRE LAS 12 PAGINAS ===');
  for (const c of ['CUENTA', 'EMAIL', 'ID_FISCAL', 'IP', 'TELEFONO', 'URL'])
    console.log('  [' + c + '_n]: ' + cuenta(new RegExp('\\[' + c + '_\\d+\\]', 'g')));

  // ningun dato crudo del PDF debe sobrevivir en la hoja del visor (la tabla de equivalencias no está en el visor)
  const crudos = ['pagina1@acmecorp.com', 'pagina12@acmecorp.com', 'ES9121000418450200051301', '192.168.14.12'];
  const fugas = crudos.filter(d => visor.includes(d));
  console.log('\ndatos crudos en el visor: ' + (fugas.length ? 'FUGA ' + fugas.join(',') : 'ninguno'));
  console.log('numero de paginas del PDF procesadas de principio a fin: ' + enVisor.length + '/' + TOTAL);

  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result?.data) { writeFileSync('pruebas/evidencia-multipagina.png', Buffer.from(r.result.data, 'base64')); console.log('captura: pruebas/evidencia-multipagina.png'); }
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='← Cerrar');b&&b.click();})()`);
  ws.close();
  process.exit(enVisor.length === TOTAL && fugas.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
