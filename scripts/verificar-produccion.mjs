import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const sha384 = bytes => 'sha384-' + createHash('sha384').update(bytes).digest('base64');
export const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
export function allowedFile(file) {
  return file === 'index.html' || file === 'build-manifest.json' || (/^assets\/[a-zA-Z0-9._/-]+\.(?:js|mjs|css|woff2|svg|txt)$/.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')));
}
async function walk(dir, prefix = '') {
  const files = [];
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (item.isSymbolicLink()) throw new Error('Symlink no permitido en dist: ' + prefix + item.name);
    if (item.isDirectory()) files.push(...await walk(path.join(dir, item.name), prefix + item.name + '/'));
    else if (item.isFile()) files.push(prefix + item.name);
    else throw new Error('Tipo no estático en dist: ' + item.name);
  }
  return files;
}
export async function verifyProduction({ dist = path.join(ROOT, 'dist'), source = true, reproducible = false } = {}) {
  const manifestBytes = await readFile(path.join(dist, 'build-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1) throw new Error('Schema de manifest incompatible.');
  const expected = [...Object.keys(manifest.files), 'build-manifest.json'].sort();
  const actual = (await walk(dist)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('dist contiene archivos faltantes o no inventariados.');
  let bytesTotal = manifestBytes.length;
  for (const file of expected) {
    if (!allowedFile(file)) throw new Error('Archivo no estático/permisible: ' + file);
    const bytes = await readFile(path.join(dist, file));
    bytesTotal += file === 'build-manifest.json' ? 0 : bytes.length;
    if (file === 'build-manifest.json') continue;
    const entry = manifest.files[file];
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256 || sha384(bytes) !== entry.integrity) throw new Error('Hash/tamaño incorrecto: ' + file);
  }
  if (source) for (const [file, hash] of Object.entries(manifest.inputs)) {
    if (!['index.html', 'package.json', 'package-lock.json'].includes(file)) throw new Error('Input inesperado.');
    if (sha256(await readFile(path.join(ROOT, file))) !== hash) throw new Error('Build desactualizado respecto a ' + file + '; repite npm run build.');
  }
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  const app = await readFile(path.join(dist, 'assets/app.js'), 'utf8');
  const bootstrap = await readFile(path.join(dist, 'assets/bootstrap.js'), 'utf8');
  if (/<script\b[^>]*type=['"]text\/babel/i.test(html) || /(?:cdn\.tailwindcss\.com|@babel\/standalone|fonts\.googleapis\.com)/.test(html)) throw new Error('Compilador/fuente remota en runtime.');
  for (const [tag, url] of [...html.matchAll(/<(script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(m => [m[1], m[2]])) {
    if (!url.startsWith('./assets/') || !manifest.files[url.slice(2)]) throw new Error(tag + ' remoto o no inventariado: ' + url);
  }
  if (/(?:https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)\/)/.test(app + bootstrap)) throw new Error('Loader aún depende de CDN.');
  if (!manifest.security.pdfJsEvalDisabledInSource || !manifest.security.csp.includes("script-src 'self'")) throw new Error('Falta mitigación PDF/CSP.');
  if (reproducible) {
    const { buildProduction } = await import('./build-produccion.mjs');
    const temp = dist + '.reproducible';
    const { rm } = await import('node:fs/promises');
    try {
      await buildProduction({ outDir: temp });
      if (sha256(await readFile(path.join(temp, 'build-manifest.json'))) !== sha256(manifestBytes)) throw new Error('El rebuild no fue idéntico byte a byte.');
      const other = await walk(temp);
      for (const file of other) if (sha256(await readFile(path.join(temp, file))) !== sha256(await readFile(path.join(dist, file)))) throw new Error('Build no reproducible: ' + file);
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  return { manifest, manifestBytes, files: expected.length, bytes: bytesTotal, sourceSHA256: manifest.inputs['index.html'], reproducible };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyProduction({ reproducible: !process.argv.includes('--no-rebuild') });
  console.log(JSON.stringify({ ok: true, files: result.files, bytes: result.bytes, sourceSHA256: result.sourceSHA256, reproducible: result.reproducible }, null, 2));
}
