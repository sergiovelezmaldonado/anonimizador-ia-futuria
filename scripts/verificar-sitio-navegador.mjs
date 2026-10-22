// Recorrido real sobre el sitio PUBLICADO: anonimiza y restaura de verdad.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const site = process.argv[2];
const scratch = process.env.TMPDIR || process.env.TEMP;
const profile = await mkdtemp(path.join(scratch, 'app7-publicado-'));
const candidates = [process.env.CHROME_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let chrome;
for (const c of candidates) { try { await access(c); chrome = c; break; } catch {} }
if (!chrome) throw new Error('No se encontró Chrome/Edge.');
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = ''; child.stderr.on('data', c => { log += c; });
const report = { site, checks: [], errors: [], external: [], ok: false };
const check = (name, pass, detail) => { report.checks.push({ name, pass, detail }); if (!pass) report.errors.push(name + ' → ' + detail); };
let socket;
try {
  let port;
  for (let i = 0; i < 300; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) break; } catch {}
    if (child.exitCode !== null) throw new Error('Chrome terminó: ' + log);
    await delay(100);
  }
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => socket.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  socket.addEventListener('message', e => {
    const d = JSON.parse(e.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id);
      d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result); }
    else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') report.errors.push('consola: ' + d.params.entry.text.slice(0, 200));
    else if (d.method === 'Network.requestWillBeSent') {
      const url = d.params.request.url;
      if (/^https?:/.test(url) && new URL(url).origin !== new URL(site).origin) report.external.push(url);
    }
  });
  const call = (m, params = {}) => new Promise((res, rej) => { const k = ++id; pending.set(k, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id: k, method: m, params })); });
  const ev = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async expr => { for (let i = 0; i < 400; i++) { if (await ev(expr)) return; await delay(100); } throw new Error('Timeout: ' + expr); };
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable'); await call('Log.enable');
  await call('Page.navigate', { url: site });
  await wait('document.querySelectorAll("[role=tab]").length >= 4 && document.getElementById("root").textContent.length > 100');
  report.browser = version.Browser;

  const mounted = await ev('({react: React.version, babel: typeof Babel, tailwind: typeof tailwind, motor: typeof runAnonymize})');
  check('React de producción sin compiladores', mounted.react === '18.3.1' && mounted.babel === 'undefined' && mounted.tailwind === 'undefined' && mounted.motor === 'function', JSON.stringify(mounted));
  check('primera pestaña es Cómo usar', await ev(`/Cómo usar$/.test(document.querySelector('[role=tab][aria-selected=true]').innerText.trim())`), 'pestaña de llegada');
  check('sin persistencia en el navegador', await ev('localStorage.length === 0 && sessionStorage.length === 0'), 'storage');

  // Flujo real: anonimizar.
  await ev(`[...document.querySelectorAll('[role=tab]')].find(b => /Anonimizar texto/.test(b.textContent)).click()`);
  await wait(`!!document.querySelector('#input-text')`);
  const original = 'Cliente: Ana Ruiz Pérez\nCorreo: ana.ruiz@miempresa.test\nCelular: 0991234567\nCédula: 1710034065\n👩‍💻 Nota con acentos: áéíóú ñ.';
  await ev(`(() => {const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;const t=document.querySelector('#input-text');s.call(t,${JSON.stringify(original)});t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await wait(`[...document.querySelectorAll('button')].some(b => !b.closest('[hidden]') && b.textContent.trim()==='Anonimizar documento' && !b.disabled)`);
  await ev(`[...document.querySelectorAll('button')].find(b => !b.closest('[hidden]') && b.textContent.trim()==='Anonimizar documento').click()`);
  await wait(`!!document.querySelector('[data-document-download="anonymized"]')`);
  const out = await ev(`(() => {const n=[...document.querySelectorAll('pre')].filter(p=>!p.closest('[hidden]'));return n.map(p=>p.textContent).find(t=>/\\[/.test(t))})()`);
  check('oculta nombre, correo, celular y cédula', !!out && !out.includes('Ana Ruiz Pérez') && !out.includes('ana.ruiz@miempresa.test') && !out.includes('0991234567') && !out.includes('1710034065'), String(out).slice(0, 160));
  check('conserva Unicode y acentos', !!out && out.includes('👩‍💻') && out.includes('áéíóú'), String(out).slice(-60));

  // Restauración con la llave de la sesión.
  const roundtrip = await ev(`(async () => {
    const anon = runAnonymize(${JSON.stringify(original)}, CATS.filter(c => c.on), '');
    const mapa = Object.fromEntries(anon.reps.map(r => [r.replacement, r.original]));
    const back = restoreTags(anon.out, mapa);
    const blobs = {};
    for (const f of ['txt','json','docx','pdf']) {
      const b = await buildTextDocumentBlob(makeTextDocument(anon.out), f, 'anonymized');
      blobs[f] = { type: b.type, size: b.size };
    }
    return { exacto: back.out === ${JSON.stringify(original)}, etiquetas: anon.reps.length, blobs };
  })()`);
  check('restaura el original exacto', roundtrip.exacto, 'etiquetas=' + roundtrip.etiquetas);
  check('genera los cuatro formatos', Object.values(roundtrip.blobs).every(b => b.size > 0), JSON.stringify(roundtrip.blobs));

  for (const width of [1366, 390, 360]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await delay(200);
    const geo = await ev('({v: innerWidth, s: document.documentElement.scrollWidth})');
    check('sin desbordamiento a ' + width + 'px', geo.s <= geo.v + 1, JSON.stringify(geo));
  }
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(process.env.TMPDIR || process.env.TEMP, 'sitio-publicado-360.png'), Buffer.from(shot.data, 'base64'));

  check('ninguna petición a otro dominio', report.external.length === 0, report.external.join(', '));
  check('sin errores de consola', report.errors.filter(e => e.startsWith('consola:')).length === 0, report.errors.join(' | '));
  report.ok = report.errors.length === 0;
} finally {
  if (socket) socket.close();
  if (child.exitCode === null) child.kill();
  try { await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  console.log(JSON.stringify({ site, browser: report.browser, ok: report.ok,
    comprobaciones: report.checks.length, fallos: report.errors, external: report.external }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
