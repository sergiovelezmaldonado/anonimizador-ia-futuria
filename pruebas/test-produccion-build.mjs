import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('build compila la fuente sin modificar index.html y produce un manifiesto verificable', async () => {
  const source = await readFile(new URL('../index.html', import.meta.url));
  const result = spawnSync(process.execPath, ['scripts/build-produccion.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(await readFile(new URL('../index.html', import.meta.url)), source);
  const manifest = JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.files['index.html']);
  assert.ok(manifest.files['assets/app.js']);
});

import { verifyProduction, sha256, allowedFile, MIME } from '../scripts/verificar-produccion.mjs';
import { startProductionServer } from '../scripts/servidor-produccion.mjs';
import vm from 'node:vm';
import { request } from 'node:http';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

test('manifest comprueba bytes, versiones exactas y reconstrucción determinista', async () => {
  const result = await verifyProduction({ reproducible: true });
  assert.equal(result.reproducible, true);
  assert.equal(result.sourceSHA256, sha256(await readFile(new URL('../index.html', import.meta.url))));
  for (const version of Object.values(result.manifest.runtimePackages)) assert.match(version, /^\d+\.\d+\.\d+$/);
  // El bundle de Mammoth se reconstruye aquí: su inventario debe traer las
  // transitivas parcheadas, no las antiguas del archivo publicado.
  const embedded = Object.fromEntries(result.manifest.embeddedInventory.mammoth.map(item => [item.name, item.version]));
  assert.equal(embedded['@xmldom/xmldom'], '0.8.15');
  assert.equal(embedded.jszip, '3.10.2');
  assert.equal(embedded.underscore, '1.13.8');
  assert.equal(result.manifest.repackagedBundles.mammoth.version, '1.13.0');
  assert.equal(result.manifest.vendorAssets['assets/vendor/mammoth-1.13.0/mammoth.browser.min.js'].repackaged, true);
  assert.equal(result.manifest.runtimePackages['pdfjs-dist'], '4.2.67');
  // Un bundle reconstruido se sirve con SU hash: el SRI del HTML empaquetado
  // debe ser el de los bytes servidos, no el del archivo publicado por npm.
  const served = result.manifest.vendorAssets['assets/vendor/mammoth-1.13.0/mammoth.browser.min.js'];
  // El SRI vive en el script de arranque, que es quien inyecta la biblioteca.
  const bootstrap = await readFile(new URL('../dist/assets/bootstrap.js', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(served.integrity), 'el paquete no declara el SRI de los bytes servidos');
  assert.ok(!bootstrap.includes('sha384-8NWE3bZDrmRI4IePMoQaEoLhAQ1MmRMJkdNgnGiHRFanTqsFKr0TmK6aSZvFJ/PO'),
    'quedó el SRI del archivo publicado, que no son los bytes servidos');
  assert.equal(served.integrity, result.manifest.repackagedBundles.mammoth.integrity);
  assert.equal(result.manifest.security.pdfJsEvalDisabledInSource, true);
});

test('JS clásico compilado conserva API global y semántica de regex/offsets/Unicode', async () => {
  const app = await readFile(new URL('../dist/assets/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, React: { createContext() {}, createElement() {} }, ReactDOM: { createRoot() { return { render() {} }; } }, document: { getElementById() { return {}; } } });
  vm.runInContext(app, context);
  assert.equal(typeof context.runAnonymize, 'function');
  assert.equal(typeof context.readTextDocumentFile, 'function');
  assert.equal(typeof context.loadTextExportLibraries, 'function');
  const result = vm.runInContext(`(() => {
    const text = '👩‍💻 Ana Ana Ana · correo: qa@example.invalid · password = "s,e;c\\\\x"';
    const anon = runAnonymize(text, CATS.filter(c => c.on), 'Ana Ana');
    const restored = restoreTags(anon.out, Object.fromEntries(anon.reps.map(r => [r.replacement, r.original])));
    const model = remapTextDocument(makeTextDocument(text), anon.out, anon.edits);
    return { text, out: anon.out, restored: restored.out, modelText: model.text };
  })()`, context);
  assert.equal(result.restored, result.text);
  assert.equal(result.modelText, result.out);
  assert.ok(!result.out.includes('Ana'));
  assert.ok(!result.out.includes('qa@example.invalid'));
  assert.ok(result.out.startsWith('👩‍💻 '));
});

test('dist no contiene compiladores runtime; clases arbitrarias y CSS inline permanecen', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../dist/assets/app.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../dist/assets/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /text\/babel|cdn\.tailwindcss|babel\.min\.js|fonts\.googleapis/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.match(css, /\.rounded-\\\[28px\\\]/);
  assert.match(css, /\.bg-\\\[\\#fff5f6\\\]/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /@font-face/);
  assert.match(css, /inter-latin-400-normal\.woff2/);
  assert.match(css, /@media print/);
  assert.match(app, /backgroundColor: cat\.bg/);
});

function rawRequest(url, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const origin = new URL(url);
    const req = request({ hostname: origin.hostname, port: origin.port, path: pathname, method }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('servidor permite sólo assets del manifiesto, MIME correcto y GET/HEAD sin abrir checkout', async () => {
  const { server, url, verified } = await startProductionServer({ port: 0 });
  try {
    for (const file of Object.keys(verified.manifest.files)) {
      const response = await rawRequest(url, '/' + file);
      assert.equal(response.status, 200, file);
      assert.equal(response.headers['content-type'], MIME[path.extname(file)]);
      assert.equal(sha256(response.bytes), verified.manifest.files[file].sha256);
    }
    for (const pathname of ['/package.json', '/package-lock.json', '/index.html.jsx', '/README.md', '/.git/config', '/pruebas/test-document-export.mjs', '/scripts/build-produccion.mjs', '/node_modules/react/package.json', '/assets/no-existe.js', '/assets/../index.html', '/%2e%2e/index.html', '/assets/%2e%2e/%2e%2e/package.json', '/%252e%252e/package.json', '/%ZZ']) {
      assert.equal((await rawRequest(url, pathname)).status, 404, pathname);
    }
    assert.equal((await rawRequest(url, '/', 'POST')).status, 405);
    const head = await rawRequest(url, '/', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
    assert.equal(head.headers['x-content-type-options'], 'nosniff');
    assert.match(head.headers['content-security-policy'], /script-src 'self';/);
    assert.ok(!head.headers['content-security-policy'].includes('unsafe-eval'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('verificación rechaza bytes alterados y archivos extra ajenos al whitelist', async () => {
  const temp = await mkdtemp(path.join(process.env.TMPDIR || process.env.TEMP, 'app7-dist-test-'));
  try {
    await cp(new URL('../dist/', import.meta.url), temp, { recursive: true });
    await writeFile(path.join(temp, 'assets/app.js'), 'alterado');
    await assert.rejects(verifyProduction({ dist: temp, source: false }), /Hash\/tamaño incorrecto/);
    await cp(new URL('../dist/', import.meta.url), temp, { recursive: true });
    await writeFile(path.join(temp, 'secret.txt'), 'no se debe servir');
    await assert.rejects(verifyProduction({ dist: temp, source: false }), /no inventariados/);
  } finally { await rm(temp, { recursive: true, force: true }); }
  for (const bad of ['assets/../index.html', '.git/config', 'assets/.git/config.js', 'assets/source.map', 'package.json']) assert.equal(allowedFile(bad), false, bad);
  // PDF.js 4.x se publica como módulo ES: .mjs debe estar permitido e inventariado.
  assert.equal(allowedFile('assets/vendor/pdfjs-dist-4.2.67/pdf.min.mjs'), true);
  assert.equal(MIME['.mjs'], 'text/javascript; charset=utf-8');
});
