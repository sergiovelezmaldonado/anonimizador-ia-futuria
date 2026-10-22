// Audit observable: no modifica versiones, no usa audit fix ni ocultamiento de avisos.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT, verifyProduction } from './verificar-produccion.mjs';
const { manifest, manifestBytes } = await verifyProduction();
const audit = flags => {
  // npm es un shim .cmd en Windows; shell necesario sólo para este comando fijo.
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json', ...flags], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
  if (result.error) throw result.error;
  let json; try { json = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || result.stdout); }
  if (json.error) throw new Error(JSON.stringify(json.error));
  return { exitCode: result.status, ...json };
};
const all = audit([]);
const installed = audit(['--omit=optional']);
const runtimeTree = audit(['--omit=optional', '--omit=dev']);
const embedded = Object.fromEntries(manifest.embeddedInventory.mammoth.map(item => [item.name, [item.version]]));
const runtimePackages = manifest.runtimePackages;
const bundleManifest = manifest.repackagedBundles?.mammoth;
if (!bundleManifest) throw new Error('El manifiesto no declara el bundle reconstruido de Mammoth.');
// Las dependencias ocultas dentro de bundles ya empaquetados deben estar en el
// inventario que se audita; si faltan, el gate no las vería.
const prepackaged = bundleManifest.prepackagedSources || {};
for (const [owner, info] of Object.entries(prepackaged)) {
  for (const name of info.hiddenPackages) {
    if (!embedded[name]) throw new Error('Dependencia interna de ' + owner + ' sin auditar: ' + name);
  }
}
const embeddedSummary = ['@xmldom/xmldom', 'jszip', 'underscore'].map(name => name + ' ' + (embedded[name] || ['?'])[0]).join(', ');
const prepackagedSummary = Object.entries(prepackaged).map(([owner, info]) => owner + ' → ' + info.hiddenPackages.join(', ')).join('; ') || 'ninguno';
const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(embedded), signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error('npm bulk advisory HTTP ' + response.status);
const embeddedAdvisories = await response.json();
const primary = {};
for (const ghsa of ['GHSA-wgrm-67xf-hhpq', 'GHSA-hq66-cqwq-w95j', 'GHSA-rmjr-87wv-gf87']) {
  const result = await fetch('https://api.github.com/advisories/' + ghsa, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'App7-static-build-audit' }, signal: AbortSignal.timeout(30000) });
  if (!result.ok) throw new Error('No se verificó advisory primaria: ' + ghsa + ' HTTP ' + result.status);
  const data = await result.json();
  primary[ghsa] = { url: data.html_url, published_at: data.published_at, updated_at: data.updated_at, summary: data.summary, description: data.description, vulnerabilities: data.vulnerabilities, references: data.references };
}
const report = {
  generatedAt: new Date().toISOString(),
  sourceSHA256: manifest.inputs['index.html'],
  manifestSHA256: createHash('sha256').update(manifestBytes).digest('hex'),
  installation: 'npm ci --ignore-scripts --omit=optional (probado); los opcionales canvas/path2d-polyfill no se instalan ni se sirven.',
  commands: { all: 'npm audit --json', installed: 'npm audit --json --omit=optional', runtime: 'npm audit --json --omit=optional --omit=dev', embedded: 'POST registry.npmjs.org/-/npm/v1/security/advisories/bulk con versiones declaradas por mammoth.browser.js' },
  allLockfile: all,
  installedWithoutOptional: installed,
  runtimeDependencyTree: runtimeTree,
  embeddedMammothPackages: embedded,
  embeddedMammothAdvisories: embeddedAdvisories,
  primaryAdvisories: primary,
  assessment: [
    'No se ha actualizado ni sustituido silenciosamente ninguna API runtime. Pin/versiones/SRI no equivalen a seguridad.',
    // Las versiones se derivan del manifiesto para que el informe no pueda
    // citar un cuadro de dependencias distinto del que se sirve.
    'PDF.js ' + runtimePackages['pdfjs-dist'] + ': GHSA-wgrm-67xf-hhpq afecta <=4.1.392 y se parchea en 4.2.67, incluido en esta versión. La fuente mantiene isEvalSupported:false; dist añade CSP sin unsafe-eval, con el módulo y el worker locales.',
    'GHSA-hq66-cqwq-w95j se evalúa contra su rango primario, no por la etiqueta latest: ' + runtimePackages['pdfjs-dist'] + ' no es la última rama y una subida mayor exigiría QA propio.',
    'Mammoth ' + runtimePackages.mammoth + ': GHSA-rmjr-87wv-gf87 requiere parche >=1.11.0, cubierto por esta versión. Además el lector externo Files.read rechaza linked files, CSP connect-src self limita la red y la importación usa DOMParser inerte sin insertar el HTML generado. Estas mitigaciones NO sustituyen el parcheo de dependencias XML/ZIP embebidas ni protegen frente a un ZIP bomb.',
    'El bundle de Mammoth se reconstruye en este repositorio (npm run build:mammoth) y sirve ' + embeddedSummary + '. Un npm audit del árbol resuelto NO cubre esos bytes: se consultan aparte en embeddedMammothAdvisories, incluidas las dependencias que viajan dentro de bundles ya empaquetados (' + prepackagedSummary + ').',
    'Avisos de Tailwind y sus transitivas son de build, no de dist. Se compila sólo la fuente local de confianza; nunca documentos o CSS aportados por usuarios. No se aplicó migración Tailwind4 por fuerza.',
    'La auditoría npm completa puede listar tar/node-pre-gyp de canvas opcional (no instalado al usar omit=optional, no servido). Se conserva el informe completo, separado del árbol instalado y del runtime.',
    'Los bundles precompilados pdfmake/docx pueden llevar transitivas distintas al lock resuelto. Este reporte no certifica SBOM completa ni seguridad cero: hashes exactos + SRI + QA de import/export son evidencia de identidad/compatibilidad, no reemplazan audit del bundle upstream.'
  ],
};
const dir = path.join(ROOT, 'scripts/reports'); await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, 'production-dependencies-audit.json'), JSON.stringify(report, null, 2) + '\n');
const embeddedCount = Object.values(embeddedAdvisories).reduce((n, list) => n + list.length, 0);
console.log(JSON.stringify({ report: path.join(dir, 'production-dependencies-audit.json'), allLockfile: all.metadata.vulnerabilities, installed: installed.metadata.vulnerabilities, runtimeTree: runtimeTree.metadata.vulnerabilities, embeddedMammothAdvisories: embeddedCount, warning: 'Hay avisos conocidos: no declarar listo para producción sin aceptar/mitigar/parchear explícitamente.' }, null, 2));
// La auditoría es una puerta de seguridad: evidencia guardada aunque termine distinto de cero.
if (Object.keys(installed.vulnerabilities || {}).length || embeddedCount) process.exitCode = 1;
