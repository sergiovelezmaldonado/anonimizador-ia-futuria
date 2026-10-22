// Verifica el sitio PUBLICADO contra el manifiesto del paquete aprobado.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = process.argv[2];
const manifest = JSON.parse(readFileSync(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fails = [];
const ok = [];

// 1) Cada archivo inventariado debe servirse con los bytes exactos del paquete.
for (const [file, info] of Object.entries(manifest.files)) {
  const url = base + '/' + file;
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200) { fails.push(file + ': HTTP ' + response.status); continue; }
  if (sha256(bytes) !== info.sha256) { fails.push(file + ': hash distinto del aprobado'); continue; }
  ok.push(file);
}

// 2) Cabeceras de protección en la raíz.
const root = await fetch(base + '/');
const headers = Object.fromEntries([...root.headers].map(([k, v]) => [k.toLowerCase(), v]));
const csp = headers['content-security-policy'] || '';
const checks = [
  ['sirve HTTPS', base.startsWith('https://')],
  ['CSP presente', !!csp],
  ['CSP sin unsafe-eval', !csp.includes('unsafe-eval')],
  ["CSP script-src 'self'", csp.includes("script-src 'self'")],
  ["frame-ancestors 'none'", csp.includes("frame-ancestors 'none'")],
  ['nosniff', headers['x-content-type-options'] === 'nosniff'],
  ['no-referrer', headers['referrer-policy'] === 'no-referrer'],
  ['X-Frame-Options DENY', headers['x-frame-options'] === 'DENY'],
  ['sin cookies', !headers['set-cookie']],
];
for (const [name, pass] of checks) (pass ? ok : fails).push('cabecera: ' + name + (pass ? '' : ' → ' + (csp || JSON.stringify(headers).slice(0, 200))));

// 3) El repositorio, las pruebas y el código fuente NO deben servirse.
for (const path of ['/package.json', '/package-lock.json', '/.git/config', '/pruebas/test-seguridad.mjs',
  '/scripts/build-produccion.mjs', '/node_modules/react/package.json', '/vercel.json', '/README.md',
  '/RELEASE-CHECKLIST.md', '/vendor/mammoth-browser/bundle-manifest.json', '/index.html.jsx']) {
  const response = await fetch(base + path);
  const body = await response.text();
  // Vercel puede responder 200 con la SPA; lo que importa es no entregar el archivo real.
  const leaked = response.status === 200 && !body.includes('<!DOCTYPE html>');
  (leaked ? fails : ok).push('no sirve ' + path + ' (HTTP ' + response.status + ')');
}

// 4) El HTML publicado no puede traer compiladores ni CDN externos.
const html = await (await fetch(base + '/')).text();
for (const [name, bad] of [['sin Babel', /babel/i], ['sin Tailwind CDN', /cdn\.tailwindcss/i],
  ['sin unpkg', /unpkg\.com/i], ['sin jsdelivr', /jsdelivr/i], ['sin Google Fonts', /fonts\.googleapis/i]]) {
  (bad.test(html) ? fails : ok).push('html publicado: ' + name);
}

console.log(JSON.stringify({
  base,
  sourceSHA256: manifest.inputs['index.html'],
  archivosVerificados: Object.keys(manifest.files).length,
  comprobacionesOK: ok.length,
  fallos: fails,
  publicado: fails.length === 0,
}, null, 2));
process.exitCode = fails.length ? 1 : 0;
