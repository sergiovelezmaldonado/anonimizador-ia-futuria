// Ejecuta Chrome/Edge PROPIO, perfil scratch y puerto CDP dinámico (nunca 9334).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, sha256 } from './verificar-produccion.mjs';
import { startProductionServer } from './servidor-produccion.mjs';
const scratch = process.env.TMPDIR || process.env.TEMP;
if (!scratch) throw new Error('Configura TMPDIR para un perfil de navegador aislado.');
const profile = await mkdtemp(path.join(scratch, 'app7-production-chrome-'));
const reportDir = path.join(ROOT, 'scripts', 'reports');
await mkdir(reportDir, { recursive: true });
const candidates = [process.env.CHROME_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
let chrome;
for (const candidate of candidates) { try { await access(candidate); chrome = candidate; break; } catch {} }
if (!chrome) throw new Error('No se encontró Chrome/Edge. Define CHROME_BIN.');
const { server, url, verified } = await startProductionServer({ port: 0 });
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = ''; child.stderr.on('data', chunk => { chromeLog += chunk.toString(); });
const sockets = [];
function connect(wsURL) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsURL); sockets.push(socket);
    const pending = new Map(), listeners = new Map(); let id = 0;
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 90000);
      pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params }));
    });
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id); if (!entry) return;
        clearTimeout(entry.timer); pending.delete(data.id);
        if (data.error) entry.reject(new Error(JSON.stringify(data.error))); else entry.resolve(data.result);
      } else for (const fn of listeners.get(data.method) || []) fn(data.params);
    });
    socket.addEventListener('error', reject, { once: true });
    socket.addEventListener('open', () => resolve({ call, on(method, fn) { const list = listeners.get(method) || []; list.push(fn); listeners.set(method, list); } }), { once: true });
  });
}
let browser, page;
const report = { ok: false, sourceSHA256: verified.sourceSHA256, manifestSHA256: sha256(verified.manifestBytes), browser: chrome, assertions: [], requests: [], externalRequests: [], errors: [], warnings: [] };
const check = (name, fn) => { fn(); report.assertions.push(name); };
try {
  let port;
  for (let i = 0; i < 300; i++) {
    try { const text = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); port = Number(text.split('\n')[0]); const ready = await fetch('http://127.0.0.1:' + port + '/json/version'); if (ready.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error('Chrome terminó: ' + chromeLog);
    await delay(100);
  }
  if (!port) throw new Error('Chrome no expuso CDP: ' + chromeLog);
  check('CDP aislado usa puerto dinámico distinto a 9334', () => assert.notEqual(port, 9334));
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  report.browserVersion = version.Browser;
  browser = await connect(version.webSocketDebuggerUrl);
  const target = await browser.call('Target.createTarget', { url: 'about:blank' });
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  page = await connect(targets.find(item => item.id === target.targetId).webSocketDebuggerUrl);
  const ev = async expression => {
    const result = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => { for (let i = 0; i < 300; i++) { if (await ev(expression)) return; await delay(100); } throw new Error('Timeout: ' + expression); };
  await page.call('Page.enable'); await page.call('Runtime.enable'); await page.call('Network.enable'); await page.call('Log.enable');
  page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => report.errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  page.on('Runtime.consoleAPICalled', params => { if (params.type === 'error') report.errors.push(params.args.map(a => a.value || a.description).join(' ')); });
  page.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') report.errors.push(entry.text); else if (entry.level === 'warning') report.warnings.push(entry.text); });
  page.on('Network.requestWillBeSent', ({ request }) => { if (/^https?:/.test(request.url)) { report.requests.push(request.url); if (new URL(request.url).origin !== url) report.externalRequests.push(request.url); } });
  await page.call('Network.setBlockedURLs', { urls: ['https://*'] });
  // CSP restringe cualquier destino externo; bloquear HTTPS también prueba no dependencia CDN.
  await page.call('Page.navigate', { url });
  await wait('document.querySelectorAll("[role=tab]").length >= 4 && document.getElementById("root").textContent.length > 100');
  const mounted = await ev('({react:React.version,babel:typeof Babel,tailwind:typeof tailwind,globals:typeof runAnonymize,style:getComputedStyle(document.querySelector("[role=tab]")).minHeight})');
  check('React producción 18.3.1 y ninguna API de compilación runtime', () => { assert.equal(mounted.react, '18.3.1'); assert.equal(mounted.babel, 'undefined'); assert.equal(mounted.tailwind, 'undefined'); assert.equal(mounted.globals, 'function'); });
  const styles = await ev(`(() => {const node=document.createElement('div'); node.className='rounded-[28px] bg-[#fff5f6] min-h-[44px]';document.body.appendChild(node);const s=getComputedStyle(node);const v={radius:s.borderRadius,bg:s.backgroundColor,min:s.minHeight};node.remove();return v})()`);
  check('Tailwind compilado preserva clases arbitrarias y colores', () => assert.deepEqual(styles, { radius: '28px', bg: 'rgb(255, 245, 246)', min: '44px' }));
  await ev('document.fonts.ready');
  const interLoaded = await ev('document.fonts.check("400 16px Inter")');
  check('Inter self-hosted cargada', () => assert.equal(interLoaded, true));
  await ev(`[...document.querySelectorAll('[role=tab]')].find(b => /Anonimizar texto/.test(b.textContent)).click()`);
  await wait(`!!document.querySelector('textarea[placeholder^="Pega aquí lo que vas"]')`);
  const original = 'Cliente: Ana Ruiz\nCorreo: prueba@example.invalid\npassword = "s,e;c"\n👩‍💻 Unicode áéíóú ñ y final.';
  await ev(`(() => {const el=document.querySelector('textarea[placeholder^="Pega aquí lo que vas"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(original)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await wait(`[...document.querySelectorAll('button')].some(b => !b.closest('[hidden]') && b.textContent.trim()==='Anonimizar documento' && !b.disabled)`);
  await ev(`[...document.querySelectorAll('button')].find(b => !b.closest('[hidden]') && b.textContent.trim()==='Anonimizar documento').click()`);
  await wait(`!!document.querySelector('[data-document-download="anonymized"]') && !!document.querySelector('input[data-review]')`);
  const output = await ev(`(() => {const nodes=[...document.querySelectorAll('pre')].filter(n=>!n.closest('[hidden]'));return nodes.map(n=>n.textContent).find(t=>t.includes('[EMAIL_1]'))})()`);
  check('UI anonimiza de verdad email, nombre y clave preservando Unicode', () => { assert.ok(output?.includes('[EMAIL_1]')); assert.ok(!output.includes('prueba@example.invalid')); assert.ok(!output.includes('Ana Ruiz')); assert.ok(!output.includes('s,e;c')); assert.ok(output.includes('👩‍💻')); });
  const before = await ev(`(() => {const node=document.querySelector('[data-document-download="anonymized"]');return [...node.querySelectorAll('button')].filter(b=>/Descargar/.test(b.textContent)).map(b=>b.disabled)})()`);
  check('UI mantiene exportación bloqueada antes de revisar', () => assert.ok(before.length && before.every(Boolean)));
  await ev(`document.querySelector('input[data-review]').click()`);
  await wait(`!document.querySelector('[data-document-download="anonymized"] button:last-of-type').disabled`);
  // Libs y artefactos REALES con API existente, sin reemplazos ni dependencias de red externa.
  const artifacts = await ev(`(async () => {
    const model = makeTextDocument('Título áéíóú ñ\\n\\n• Uno\\tDos\\n2. Tres\\nFin 👩‍💻');
    model.blocks[0].kind='heading'; model.blocks[0].level=1; model.blocks[0].runs=[{start:0,end:12,bold:true}];
    const docxBlob = await buildTextDocumentBlob(model,'docx','anonymized');
    const docxBytes = new Uint8Array(await docxBlob.arrayBuffer());
    const imported = await readTextDocumentFile(new File([docxBlob],'qa.docx',{type:docxBlob.type}));
    const pdfBlob = await buildTextDocumentBlob(model,'pdf','anonymized');
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const pdfImported = await readTextDocumentFile(new File([pdfBlob],'qa.pdf',{type:'application/pdf'}));
    const txtBlob = await buildTextDocumentBlob(model,'txt','anonymized');
    const jsonBlob = await buildTextDocumentBlob(model,'json','anonymized');
    const parsed = parseTextDocumentJSON(await jsonBlob.text());
    const encode = bytes => {let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary)};
    return {source:model.text,pdfVersion:pdfjsLib.version,docx:{type:docxBlob.type,size:docxBlob.size,magic:[...docxBytes.slice(0,4)],text:imported.text,bytes:encode(docxBytes)},pdf:{type:pdfBlob.type,size:pdfBlob.size,magic:[...pdfBytes.slice(0,5)],text:pdfImported.text,bytes:encode(pdfBytes)},txt:await txtBlob.text(),json:parsed.text,worker:pdfjsLib.GlobalWorkerOptions.workerSrc,scriptSources:[...document.scripts].map(s=>s.src)};
  })()`);
  for (const format of ['docx', 'pdf']) await writeFile(path.join(reportDir, 'production-roundtrip.' + format), Buffer.from(artifacts[format].bytes, 'base64'));
  delete artifacts.docx.bytes; delete artifacts.pdf.bytes;
  report.artifacts = artifacts;
  check('DOCX real ZIP y Mammoth reimporta contenido', () => { assert.deepEqual(artifacts.docx.magic, [80,75,3,4]); assert.ok(artifacts.docx.text.includes('Título áéíóú ñ')); assert.ok(artifacts.docx.text.includes('Uno\tDos')); });
  check('PDF.js corre la versión parcheada 4.2.67', () => assert.equal(artifacts.pdfVersion, '4.2.67'));
  check('PDF real y PDF.js con worker local reimporta contenido', () => { assert.deepEqual(artifacts.pdf.magic, [37,80,68,70,45]); assert.ok(artifacts.pdf.text.includes('Título áéíóú ñ')); assert.ok(artifacts.pdf.text.includes('Tres')); assert.ok(artifacts.worker.startsWith(url) && artifacts.worker.endsWith('.mjs')); });
  check('TXT y JSON preservan texto exacto', () => { assert.equal(artifacts.txt, artifacts.source); assert.equal(artifacts.json, artifacts.source); });
  check('Todos los loaders, worker y fuentes se sirven desde dist', () => { assert.ok(artifacts.scriptSources.every(src => src.startsWith(url))); assert.equal(report.externalRequests.length, 0); });
  // Captura y overflow de dos anchos, con el flujo de trabajo ya montado.
  report.layout = [];
  for (const width of [1366, 360]) {
    await page.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(150);
    const geometry = await ev('({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
    report.layout.push(geometry);
    check('Sin overflow horizontal ' + width + 'px', () => assert.ok(geometry.scrollWidth <= geometry.viewport + 1, JSON.stringify(geometry)));
    const shot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(reportDir, 'production-' + width + '.png'), Buffer.from(shot.data, 'base64'));
  }
  check('Ninguna excepción JS/CSP ni solicitud externa en toda la sesión', () => { assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []); });
  const finalManifest = await readFile(path.join(ROOT, 'dist/build-manifest.json'));
  check('Los bytes verificados son el build vigente', () => assert.equal(sha256(finalManifest), report.manifestSHA256));
  report.ok = true;
} catch (error) { report.failure = error.stack; throw error; }
finally {
  await writeFile(path.join(reportDir, 'production-browser.json'), JSON.stringify(report, null, 2) + '\n');
  if (browser) { try { await browser.call('Browser.close'); } catch {} }
  for (const socket of sockets) socket.close();
  await new Promise(resolve => server.close(resolve));
  if (child.exitCode === null) child.kill();
  try { await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  console.log(JSON.stringify({ ok: report.ok, assertions: report.assertions.length, sourceSHA256: report.sourceSHA256, artifacts: reportDir, errors: report.errors, failure: report.failure }, null, 2));
}
