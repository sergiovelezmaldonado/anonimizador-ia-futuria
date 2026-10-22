// Sonda CDP del Anonimizador IA: carga, estilos, y flujo REAL de anonimizacion.
// Requiere: servidor estatico en 5199 y Chrome headless con --remote-debugging-port=9334
// Fase 0: una sola pestaña de trabajo ('🔒 Anonimizar texto', fusiona Texto+Documento),
// etiquetas del resultado como <button class="anon"> y <mark class="anon"> en la tabla.
const URL_APP = 'http://localhost:5199/';
const CDP = 'http://127.0.0.1:9334';

const TEXTO_PRUEBA = [
  'Estimado cliente, su cuenta IBAN ES9121000418450200051332 presenta saldo pendiente.',
  'Contacto: maria.lopez@acmecorp.com, telefono +52 55 1234 5678.',
  'RFC del titular: GODE561231GR8. CURP: GODE561231HDFNRN09.',
  'Acceso de soporte: api_key=«redacted:sk_live_…»',
  'Servidor interno 192.168.14.22, portal https://intranet.acmecorp.com/clientes',
  'Monto adeudado: $85.340 con vencimiento el 15/03/2026.'
].join('\n');

async function main() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const consoleErrors = [], pageErrors = [], failedReqs = [], netRequests = [];

  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 200));
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '?').slice(0, 300));
    if (m.method === 'Network.loadingFailed') failedReqs.push(m.params.errorText);
    if (m.method === 'Network.requestWillBeSent') netRequests.push(m.params.request.url);
  });

  const send = (method, params = {}) => new Promise(res => {
    const myId = ++id; pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.text) };
    return r.result?.result?.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  // Runtime.enable puede repetir excepciones de una prueba anterior: medir desde esta navegacion.
  pageErrors.length = 0; netRequests.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(9000);

  const checks = [];
  const check = (nombre, ok, detalle) => checks.push({ nombre, ok: !!ok, detalle });

  // --- Carga y dependencias ---
  check('titulo correcto', (await evalJs('document.title')) === 'Anonimizador IA — FuturIA', await evalJs('document.title'));
  const rv = await evalJs('typeof React!=="undefined"?React.version:null');
  check('React 18.3.1 pinneado', String(rv).startsWith('18.3.1'), rv);
  check('Babel presente', await evalJs('typeof Babel!=="undefined"'));
  check('React monto el arbol', (await evalJs('document.getElementById("root").children.length')) >= 1);
  check('sin excepciones de pagina', pageErrors.length === 0, pageErrors.join(' | '));

  // Tailwind REALMENTE aplicado (un 200 del CDN no lo prueba): cualquier AppButton lleva rounded-2xl.
  const br = await evalJs('(()=>{const e=document.querySelector("button.rounded-2xl")||document.querySelector("[class*=rounded-2xl]");return e?getComputedStyle(e).borderRadius:"no-el";})()');
  check('Tailwind aplicado de verdad', br !== 'no-el' && br !== '0px', 'border-radius=' + br);
  const fuente = await evalJs('getComputedStyle(document.body).fontFamily');
  check('tipografia Inter', String(fuente).includes('Inter'), fuente);

  // --- Pestanas esperadas (patrón tablist de la Fase 0) ---
  const tabs = JSON.parse(await evalJs('JSON.stringify(Array.from(document.querySelectorAll("[role=tablist] [role=tab]")).map(b=>b.innerText.trim()))'));
  for (const t of ['Cómo usar', 'Anonimizar texto', 'Privacidad'])
    check('pestana presente: ' + t, tabs.some(x => x.includes(t)), 'tabs=' + tabs.join(' / '));
  check('pestana Restaurar datos originales presente', tabs.some(x => x.includes('Restaurar datos originales')));
  check('pestana Ajustes presente y en segundo lugar', /Ajustes$/.test(tabs[1] || ''), 'tabs=' + tabs.join(' / '));
  check('«Cómo usar» es la primera pestaña y la de llegada', /Cómo usar$/.test(tabs[0]) && await evalJs(`/Cómo usar$/.test(document.querySelector('[role=tab][aria-selected=true]').innerText.trim())`));

  // --- Flujo real: ir a la pestaña de trabajo; pegar, anonimizar ---
  const fueATexto = await evalJs(`(()=>{
    const b=Array.from(document.querySelectorAll('[role=tab]')).find(x=>/Anonimizar texto/.test(x.innerText));
    if(!b) return false; b.click(); return true; })()`);
  await sleep(300);
  check('navega a la pestana de trabajo (Ocultar datos)', fueATexto && await evalJs(`!!document.querySelector('#input-text')`));
  check('la pestana de trabajo fusiona Texto y Documento (textarea + input de archivo juntos)',
    await evalJs(`(()=>{const ta=document.querySelector('#input-text');return !!ta && !!ta.closest('section').querySelector('input[type=file]')})()`));
  await sleep(1200);

  const pego = await evalJs(`(()=>{
    const ta=document.getElementById('input-text');
    if(!ta) return 'no-textarea';
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(ta, ${JSON.stringify(TEXTO_PRUEBA)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return ta.value.length; })()`);
  check('texto de prueba cargado en el area', typeof pego === 'number' && pego > 100, 'chars=' + pego);
  await sleep(1200);

  const clicAnon = await evalJs(`(()=>{
    const b=Array.from(document.querySelectorAll('button')).find(x=>/Anonimizar documento/.test(x.innerText)&&!x.disabled);
    if(!b) return false; b.click(); return true; })()`);
  check('boton Anonimizar documento accionable', clicAnon);
  await sleep(3000);

  const txt = String(await evalJs('document.body.innerText'));
  const marks = await evalJs('document.querySelectorAll("button.anon").length');
  check('genera etiquetas (button.anon en el resultado)', marks > 0, 'etiquetas=' + marks);

  // Etiquetas REALES que usa la app (tag de cada categoria en el codigo),
  // no los nombres de los ids: credential->CREDENCIAL, financial->CUENTA, fiscal->ID_FISCAL.
  const esperadas = ['CREDENCIAL', 'EMAIL', 'CUENTA', 'ID_FISCAL', 'IP', 'TELEFONO', 'URL'];
  const detectadas = esperadas.filter(c => new RegExp('\\[' + c).test(txt));
  check('detecta >=6 de 7 categorias sensibles', detectadas.length >= 6, 'detectadas=' + detectadas.join(','));
  for (const c of ['CUENTA', 'ID_FISCAL'])
    check('anonimiza categoria ' + c, new RegExp('\\[' + c).test(txt), null);

  // La fuga se mide SOLO en el bloque anonimizado (el <pre> que contiene los button.anon).
  // La tabla de equivalencias muestra los originales A PROPOSITO (es lo que permite revertir);
  // medir la fuga ahi da un falso positivo.
  const anonBlock = String(await evalJs(`(()=>{
    const m=document.querySelector('button.anon'); if(!m) return '';
    const pre=m.closest('pre');
    return pre ? pre.innerText : m.parentElement.innerText;
  })()`));
  check('el bloque anonimizado existe y tiene contenido', anonBlock.length > 50, 'chars=' + anonBlock.length);

  const fugas = [];
  for (const [etq, dato] of [
    ['apikey', '«redacted:sk_live_…»'],
    ['email', 'maria.lopez@acmecorp.com'],
    ['IBAN', 'ES9121000418450200051332'],
    ['RFC', 'GODE561231GR8'],
  ]) if (anonBlock.includes(dato)) fugas.push(etq);
  check('ningun dato crudo en el bloque anonimizado', fugas.length === 0, fugas.length ? 'FUGA: ' + fugas.join(',') : 'sin fugas');

  // La tabla de equivalencias SI debe conservar los originales (reversibilidad), con <mark class="anon">.
  const marksTabla = await evalJs('document.querySelectorAll("table mark.anon").length');
  check('tabla de equivalencias conserva originales', txt.includes('maria.lopez@acmecorp.com') && marksTabla > 0, 'marks en tabla=' + marksTabla);

  check('muestra semaforo de riesgo residual', /Revisa antes de copiar|Quedan datos por ocultar/i.test(txt) && await evalJs(`!!document.querySelector('[role=region][aria-label="Estado de revisión"] input[data-review]')`), null);

  // --- Privacidad: ninguna peticion a un backend ---
  const dominios = [...new Set(netRequests.map(u => { try { return new URL(u).host; } catch { return u; } }))];
  const permitidos = ['localhost:5199', 'unpkg.com', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  const externos = dominios.filter(d => !permitidos.includes(d));
  check('solo CDNs conocidos, ningun backend', externos.length === 0, 'inesperados=' + (externos.join(' ') || 'ninguno'));
  const ls = await evalJs('localStorage.length');
  check('sin persistencia localStorage', ls === 0, 'items=' + ls);

  // --- Sondas de ancho ---
  for (const w of [1280, 900, 520]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w <= 520 });
    await sleep(1200);
    const r = JSON.parse(await evalJs('JSON.stringify({i:window.innerWidth,s:document.documentElement.scrollWidth})'));
    check('sin desbordamiento a ' + w + 'px', r.s <= r.i + 2, JSON.stringify(r));
  }
  await send('Emulation.clearDeviceMetricsOverride');

  const fallidas = checks.filter(c => !c.ok);
  console.log('\n=== SONDA ANONIMIZADOR IA ===');
  for (const c of checks) console.log((c.ok ? '  OK  ' : ' FALLA') + ' | ' + c.nombre + (c.detalle ? '  -> ' + c.detalle : ''));
  console.log('\nTOTAL: ' + checks.length + ' | OK: ' + (checks.length - fallidas.length) + ' | FALLAS: ' + fallidas.length);
  if (consoleErrors.length) console.log('\nconsole.error:\n' + consoleErrors.map(e => '  - ' + e).join('\n'));
  if (failedReqs.length) console.log('\npeticiones fallidas: ' + failedReqs.join(', '));
  ws.close();
  process.exit(fallidas.length ? 1 : 0);
}
main().catch(e => { console.error('SONDA FALLO:', e.message); process.exit(2); });
