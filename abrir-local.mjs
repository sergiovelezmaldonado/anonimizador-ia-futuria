import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.ANON_PORT || 5199);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Puerto local no válido');
const url = 'http://127.0.0.1:' + port + '/';
const serverVersion = 'futuria-local-2';
const incompatible = reason => new Error(reason + ' Detén la instancia anterior y reinicia el servidor local con esta versión. No se detendrá ningún proceso automáticamente.');
const request = (path = '/', options = {}) => fetch(new URL(path, url), { ...options, redirect: 'manual', signal: AbortSignal.timeout(1000) });
const ready = async () => {
  let response;
  try {
    response = await request();
  } catch {
    return false;
  }
  if (response.status !== 200 || !(await response.text()).includes('<title>Anonimizador IA — FuturIA</title>')) throw incompatible('El puerto está ocupado por otra aplicación.');
  if (response.headers.get('x-anonimizador-server') !== serverVersion) throw incompatible('La instancia local es antigua o no tiene la marca de versión requerida.');
  const protections = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store' };
  if (Object.entries(protections).some(([key, value]) => response.headers.get(key) !== value) || response.headers.has('set-cookie')) throw incompatible('La instancia local no entrega las cabeceras de protección esperadas.');
  try {
    for (const path of ['/.git/config', '/README.md', '/pruebas/test-servidor.mjs']) {
      // Solo HEAD: comprobar la lista cerrada sin leer archivos privados.
      if ((await request(path, { method: 'HEAD' })).status !== 404) throw new Error('archivos expuestos');
    }
    if ((await request('/', { method: 'POST' })).status !== 405) throw new Error('métodos no restringidos');
  } catch {
    throw incompatible('La instancia local no cumple las protecciones de archivos y métodos esperadas.');
  }
  return true;
};
try {
  if (!await ready()) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./servidor-local.mjs', import.meta.url))], {
      cwd: dirname(fileURLToPath(import.meta.url)), detached: true, stdio: 'ignore', windowsHide: true,
    });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    let running = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      if (spawnError) throw new Error('No se pudo iniciar el servidor local: ' + (spawnError.code || spawnError.message));
      if (await ready()) { running = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!running) throw new Error('El servidor local no pudo iniciar. Ejecuta node servidor-local.mjs para ver el error.');
  }
  console.log('Aplicación lista en ' + url);
  if (process.env.ANON_NO_BROWSER !== '1') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => { console.error('Abre esta dirección en tu navegador: ' + url); });
    browser.unref();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
