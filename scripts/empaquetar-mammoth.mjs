// Reconstruye mammoth.browser.min.js desde node_modules con transitivas parcheadas.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stage = path.join(root, 'node_modules/.cache/mammoth-bundle');
const target = path.join(root, 'vendor/mammoth-browser');
const sri = bytes => 'sha384-' + createHash('sha384').update(bytes).digest('base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies.mammoth;
const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/mammoth/package.json'), 'utf8'));
if (installed.version !== version) throw new Error('Ejecuta npm ci: mammoth instalado ' + installed.version + ' ≠ ' + version);

// Entry dentro del proyecto para que browserify resuelva mammoth y aplique su mapa "browser".
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const entry = path.join(stage, 'entry.js');
fs.writeFileSync(entry, "module.exports = require('mammoth');\n");

const run = (bin, args) => execFileSync(process.execPath, [path.join(root, bin), ...args], { cwd: root, maxBuffer: 1 << 29 });
const bundle = run('node_modules/browserify/bin/cmd.js', [entry, '--standalone', 'mammoth']);
fs.writeFileSync(path.join(stage, 'mammoth.browser.js'), bundle);
const minified = run('node_modules/uglify-js/bin/uglifyjs', [path.join(stage, 'mammoth.browser.js'), '--compress', '--mangle']);

const text = minified.toString('utf8');
if (!text.includes('convertToHtml')) throw new Error('El bundle no expone convertToHtml.');
// El inventario sale de los archivos que browserify incluyó realmente, no del
// árbol npm: así un paquete que solo usa la CLI no se declara como embebido.
const included = run('node_modules/browserify/bin/cmd.js', [entry, '--standalone', 'mammoth', '--list'])
  .toString('utf8').split(/\r?\n/).filter(Boolean).map(file => file.replace(/\\/g, '/'));
const embedded = {};
for (const file of included) {
  const parts = file.split('/node_modules/');
  if (parts.length < 2) continue;
  const tail = parts.at(-1).split('/');
  const name = tail[0].startsWith('@') ? tail[0] + '/' + tail[1] : tail[0];
  const dir = file.slice(0, file.length - parts.at(-1).length) + name;
  const meta = path.join(dir, 'package.json');
  if (!fs.existsSync(meta)) continue;
  const { version } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  embedded[name] = [...new Set([...(embedded[name] || []), version])].sort();
}
if (!embedded['@xmldom/xmldom'] || !embedded.jszip) throw new Error('El inventario del bundle no detectó las transitivas esperadas.');

// Un paquete que entra al bundle como UN SOLO archivo ya empaquetado
// (jszip → dist/jszip.min.js) mete sus dependencias DENTRO de esos bytes, donde
// `--list` no las ve. Hay que declararlas o quedan fuera del gate de auditoría.
// La detección no mira el nombre del archivo —un bundle puede llamarse
// .umd.js o bundle.js—: se identifica por aportar un único archivo teniendo
// dependencias propias. Un paquete que aporta sus módulos uno a uno (mammoth,
// lop) no esconde nada: si una dependencia suya no aportó archivos es que el
// navegador no la usa (argparse y sprintf-js solo sirven a su CLI), y
// declararla afirmaría que se sirve código ausente.
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const lockVersion = name => lock.packages['node_modules/' + name]?.version;
// npm puede anidar un paquete bajo su consumidor (mammoth/node_modules/underscore),
// así que se resuelve desde donde esté instalado, no desde la raíz.
const packageDirs = {};
const readPackage = name => {
  const candidates = [packageDirs[name], path.join(root, 'node_modules', name)].filter(Boolean);
  for (const dir of candidates) {
    const meta = path.join(dir, 'package.json');
    if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8'));
  }
  return null;
};
// Las dependencias que el propio paquete sustituye por un archivo suyo mediante
// "browser" NO están en los bytes: declararlas sería afirmar que se sirve
// código ausente.
const remapped = name => {
  const browser = readPackage(name)?.browser;
  if (!browser || typeof browser === 'string') return new Set();
  return new Set(Object.entries(browser).filter(([, to]) => typeof to === 'string').map(([from]) => from));
};
const ownFiles = {};
for (const file of included) {
  const parts = file.split('/node_modules/');
  if (parts.length < 2) continue;
  const tail = parts.at(-1).split('/');
  const owner = tail[0].startsWith('@') ? tail[0] + '/' + tail[1] : tail[0];
  (ownFiles[owner] ||= []).push(parts.at(-1).slice(owner.length + 1));
  packageDirs[owner] ||= file.slice(0, file.length - parts.at(-1).length) + owner;
}
const prepackagedSources = {};
for (const [owner, files] of Object.entries(ownFiles)) {
  if (files.length !== 1) continue;
  const sustituidas = remapped(owner);
  const hidden = {};
  const walk = (name, depth = 0) => {
    if (depth > 8 || hidden[name] || ownFiles[name]) return;
    const version = lockVersion(name);
    if (!version) return;
    hidden[name] = [version];
    const propias = remapped(name);
    for (const child of Object.keys(readPackage(name)?.dependencies || {})) {
      if (!propias.has(child)) walk(child, depth + 1);
    }
  };
  for (const name of Object.keys(readPackage(owner)?.dependencies || {})) {
    if (!sustituidas.has(name)) walk(name);
  }
  if (Object.keys(hidden).length) {
    prepackagedSources[owner] = { files: files.sort(), hiddenPackages: Object.keys(hidden).sort() };
    Object.assign(embedded, hidden);
  }
}
// Regla genérica, no un chequeo a medida de jszip: ninguna dependencia de un
// paquete servido como bundle único puede quedar sin declarar.
for (const [owner, files] of Object.entries(ownFiles)) {
  if (files.length !== 1) continue;
  const sustituidas = remapped(owner);
  for (const dep of Object.keys(readPackage(owner)?.dependencies || {})) {
    if (sustituidas.has(dep) || ownFiles[dep] || embedded[dep] || !lockVersion(dep)) continue;
    throw new Error('Dependencia de ' + owner + ' sin archivos propios ni declarar: ' + dep);
  }
}

fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'mammoth.browser.min.js'), minified);
const manifest = {
  schemaVersion: 1,
  package: 'mammoth',
  version,
  builtWith: {
    browserify: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/browserify/package.json'), 'utf8')).version,
    'uglify-js': JSON.parse(fs.readFileSync(path.join(root, 'node_modules/uglify-js/package.json'), 'utf8')).version,
    node: process.version,
  },
  file: 'mammoth.browser.min.js',
  bytes: minified.length,
  sha256: sha256(minified),
  integrity: sri(minified),
  embeddedPackages: embedded,
  prepackagedSources,
  includedFiles: included.length,
  note: 'Bundle propio: sustituye el mammoth.browser.min.js publicado, que viene con transitivas antiguas. El inventario lista los paquetes cuyos archivos entraron al bundle MÁS las dependencias que viajan dentro de bundles ya empaquetados (ver prepackagedSources: jszip entra minificado y sus dependencias no son visibles por archivo). Los paquetes que solo usa la CLI de Node (argparse, sprintf-js) no se incluyen porque no entran al bundle. Regenerar con npm run build:mammoth tras cambiar mammoth o sus dependencias.',
};
fs.writeFileSync(path.join(target, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.rmSync(stage, { recursive: true, force: true });
console.log(JSON.stringify({ version, bytes: minified.length, sha256: manifest.sha256, integrity: manifest.integrity, embedded }, null, 2));
