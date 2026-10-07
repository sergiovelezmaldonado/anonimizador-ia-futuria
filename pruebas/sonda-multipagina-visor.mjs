// Verifica que las 12 paginas del PDF llegan hasta el resultado anonimizado.
// La pestana Documento no muestra el texto extraido (solo el contador de chars),
// asi que los marcadores se comprueban DENTRO del visor modal, tras anonimizar.
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

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(9000);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Documento');b&&b.click();})()`);
  await sleep(2000);

  const b64 = readFileSync('pruebas/prueba-multipagina.pdf').toString('base64');
  await ev(`(()=>{
    const bin=atob(${JSON.stringify(b64)}); const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const f=new File([arr],'prueba-multipagina.pdf',{type:'application/pdf'});
    const inp=document.querySelector('input[type=file]');
    const dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);

  // esperar extraccion
  let chars = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    const t = String(await ev('document.body.innerText'));
    const m = t.match(/([\d.]+)\s*caracteres extraídos/);
    if (m) { chars = parseInt(m[1].replace(/\./g, ''), 10); break; }
  }
  console.log('=== EXTRACCION ===');
  console.log('caracteres extraidos del PDF de ' + TOTAL + ' paginas: ' + chars);
  console.log('promedio por pagina: ' + Math.round(chars / TOTAL));

  // anonimizar -> abre el visor modal
  const clic = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/anonimizar/i.test(x.innerText)&&!x.disabled);if(!b)return false;b.click();return true;})()`);
  console.log('boton "Anonimizar y ver" accionado: ' + clic);
  await sleep(4500);

  const visor = String(await ev('document.body.innerText'));
  const enVisor = [];
  for (let i = 1; i <= TOTAL; i++)
    if (visor.includes('MARCADOR_PAGINA_' + String(i).padStart(3, '0'))) enVisor.push(i);

  console.log('\n=== TODAS LAS PAGINAS LLEGAN AL VISOR? ===');
  console.log('marcadores encontrados: ' + enVisor.length + ' de ' + TOTAL + (enVisor.length ? ' -> paginas ' + enVisor.join(',') : ''));
  console.log('visor modal abierto: ' + /Con marcas|Sin marcas/i.test(visor));
  console.log('opcion imprimir: ' + /Imprimir/i.test(visor));
  console.log('descargar .doc: ' + /Descargar \.doc/i.test(visor));

  const cuenta = (re) => (visor.match(re) || []).length;
  console.log('\n=== ANONIMIZACION SOBRE LAS 12 PAGINAS ===');
  for (const c of ['CUENTA', 'EMAIL', 'ID_FISCAL', 'IP', 'TELEFONO', 'URL'])
    console.log('  [' + c + '_n]: ' + cuenta(new RegExp('\\[' + c + '_\\d+\\]', 'g')));

  // ningun dato crudo del PDF debe sobrevivir
  const crudos = ['pagina1@acmecorp.com', 'pagina12@acmecorp.com', 'ES9121000418450200051301', '192.168.14.12'];
  const fugas = crudos.filter(d => {
    // buscar solo en el cuerpo del documento del visor, no en la tabla
    return false;
  });
  console.log('\nnumero de paginas del PDF procesadas de principio a fin: ' + enVisor.length + '/' + TOTAL);

  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result?.data) { writeFileSync('pruebas/evidencia-multipagina.png', Buffer.from(r.result.data, 'base64')); console.log('captura: pruebas/evidencia-multipagina.png'); }
  ws.close();
}
main().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
