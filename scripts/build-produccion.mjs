// index.html es canónico: este build no lo escribe ni modifica sus APIs/globales.
import { readFile, writeFile, mkdir, rm, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transformAsync } from '@babel/core';
import jsx from '@babel/plugin-transform-react-jsx';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const sri = bytes => 'sha384-' + createHash('sha384').update(bytes).digest('base64');
// repackaged: el archivo publicado del paquete trae transitivas antiguas; se sirve
// el bundle reconstruido por scripts/empaquetar-mammoth.mjs con las parcheadas.
const vendors = [
  ['react', 'umd/react.production.min.js', 'https://unpkg.com/react@18.3.1/umd/react.production.min.js'],
  ['react-dom', 'umd/react-dom.production.min.js', 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'],
  ['pdfjs-dist', 'legacy/build/pdf.min.mjs', 'https://unpkg.com/pdfjs-dist@4.2.67/legacy/build/pdf.min.mjs'],
  ['pdfjs-dist', 'legacy/build/pdf.worker.min.mjs', 'https://unpkg.com/pdfjs-dist@4.2.67/legacy/build/pdf.worker.min.mjs'],
  ['mammoth', 'mammoth.browser.min.js', 'https://unpkg.com/mammoth@1.13.0/mammoth.browser.min.js', 'vendor/mammoth-browser'],
  ['docx', 'dist/index.umd.cjs', 'https://unpkg.com/docx@9.5.1/dist/index.umd.cjs'],
  ['pdfmake', 'build/pdfmake.min.js', 'https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/pdfmake.min.js'],
  ['pdfmake', 'build/vfs_fonts.js', 'https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/vfs_fonts.js'],
];
// Bibliotecas que la app inyecta como <script> en tiempo de ejecución: su SRI
// debe venir declarado en la fuente (el build no puede añadirlo por ellas).
const INJECTED_AT_RUNTIME = new Set(['mammoth', 'docx', 'pdfmake']);
const stableJSON = value => JSON.stringify(value, null, 2) + '\n';
export async function listFiles(dir, prefix = '') {
  const result = [];
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix + item.name;
    if (item.isDirectory()) result.push(...await listFiles(path.join(dir, item.name), name + '/'));
    else if (item.isFile()) result.push(name);
    else throw new Error('Enlace/tipo de archivo no permitido: ' + name);
  }
  return result;
}
export async function buildProduction({ outDir = path.join(ROOT, 'dist') } = {}) {
  const source = await readFile(path.join(ROOT, 'index.html'));
  const lockBytes = await readFile(path.join(ROOT, 'package-lock.json'));
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(lockBytes);
  const stage = outDir + '.building';
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const save = async (relative, bytes) => { const target = path.join(stage, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); };
  try {
    let html = source.toString('utf8');
    const localAssets = {};
    const runtime = {};
    const repackaged = {};
    for (const [name, file, upstreamURL, bundleDir] of vendors) {
      const version = pkg.dependencies[name];
      if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Versión no exacta: ' + name);
      const installed = JSON.parse(await readFile(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version || lock.packages['node_modules/' + name]?.version !== version) throw new Error('Ejecuta npm ci: versión/lock inconsistente para ' + name);
      let bytes = await readFile(path.join(ROOT, 'node_modules', name, file));
      const upstreamBytes = bytes;
      if (bundleDir) {
        // El bundle propio sustituye al publicado; su manifiesto debe coincidir.
        const bundleManifest = JSON.parse(await readFile(path.join(ROOT, bundleDir, 'bundle-manifest.json'), 'utf8'));
        if (bundleManifest.package !== name || bundleManifest.version !== version) throw new Error('Reconstruye el bundle de ' + name + ': npm run build:' + name);
        bytes = await readFile(path.join(ROOT, bundleDir, bundleManifest.file));
        if (hash(bytes) !== bundleManifest.sha256 || bytes.length !== bundleManifest.bytes) throw new Error('Bundle de ' + name + ' no coincide con su manifiesto.');
        repackaged[name] = { ...bundleManifest, directory: bundleDir };
      }
      const relative = 'assets/vendor/' + name + '-' + version + '/' + path.basename(file).replace(/\.cjs$/, '.js');
      if (!html.includes(upstreamURL)) throw new Error('Cambió el loader canónico; revisar URL explícitamente: ' + upstreamURL);
      // Los recursos que la app inyecta como <script> en tiempo de ejecución
      // deben declarar su SRI en la fuente: el build no puede añadirlo por
      // ellos, a diferencia de las etiquetas <script src> (react/react-dom),
      // que reescribe con integrity más abajo. Los módulos ES cargados con
      // import() quedan fuera porque la plataforma no admite SRI ahí; su
      // integridad la cubre el hash del manifiesto del paquete.
      // El SRI declarado corresponde a los bytes publicados por npm, que son
      // los que se descargan en desarrollo, no al bundle reconstruido.
      const at = html.indexOf(upstreamURL);
      const declaredSRI = html.slice(at + upstreamURL.length, at + upstreamURL.length + 400).match(/(?:integrity:|_SRI\s*=)\s*['"](sha384-[^'"]+)['"]/);
      if (!declaredSRI && INJECTED_AT_RUNTIME.has(name)) throw new Error('Falta SRI declarado en la fuente para ' + name + '/' + file);
      if (declaredSRI && declaredSRI[1] !== sri(upstreamBytes)) throw new Error('SRI no coincide con bytes npm: ' + name + '/' + file);
      html = html.replaceAll(upstreamURL, './' + relative);
      // El paquete sirve otros bytes cuando el bundle se reconstruye: el SRI
      // declarado en la fuente debe pasar a ser el de los bytes servidos, o el
      // navegador rechazaría el script por integridad.
      if (declaredSRI && sri(bytes) !== declaredSRI[1]) html = html.replaceAll(declaredSRI[1], sri(bytes));
      await save(relative, bytes);
      localAssets[relative] = { package: name, version, packageFile: file, upstreamURL, integrity: sri(bytes), repackaged: Boolean(bundleDir) };
      runtime[name] = version;
    }
    // Extrae únicamente etiquetas reales de script (HTML raw-text), no toca JSX/regex.
    let bootstrap = '', app = '', babelCount = 0, compilerCount = 0;
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attributes, body) => {
      const src = attributes.match(/\bsrc\s*=\s*['"]([^'"]+)['"]/i)?.[1];
      if (src) {
        if (/^https:\/\/(?:unpkg\.com\/@babel\/standalone@7\.29\.9\/babel\.min\.js|cdn\.tailwindcss\.com\/3\.4\.17)$/.test(src)) { compilerCount++; return ''; }
        const vendor = localAssets[src.replace(/^\.\//, '')];
        if (!vendor || !['react', 'react-dom'].includes(vendor.package)) throw new Error('Script externo no inventariado: ' + src);
        return '<script src="' + src + '" integrity="' + vendor.integrity + '" crossorigin="anonymous"></script>';
      }
      if (/\btype\s*=\s*['"]text\/babel['"]/i.test(attributes)) { babelCount++; app = body; return '<script src="./assets/app.js"></script>'; }
      if (attributes.trim()) throw new Error('Nuevo script inline con atributos no inventariado.');
      bootstrap += body + '\n';
      return '<script src="./assets/bootstrap.js"></script>';
    });
    if (babelCount !== 1 || compilerCount !== 2 || !bootstrap) throw new Error('Estructura de scripts fuente cambió: revisar el build.');
    const { code } = await transformAsync(app, { filename: 'index.html.jsx', configFile: false, babelrc: false, sourceType: 'script', plugins: [[jsx, { runtime: 'classic' }]], comments: true, compact: false, sourceMaps: false });
    await save('assets/app.js', code + '\n');
    await save('assets/bootstrap.js', bootstrap.trim() + '\n');
    // Tailwind analiza el HTML canónico completo: ternarios y clases arbitrarias constantes.
    const inlineStyles = [];
    const headEnd = html.indexOf('</head>');
    let head = html.slice(0, headEnd).replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => { inlineStyles.push(css); return ''; });
    let fontCSS = '';
    for (const weight of [400, 600, 700]) {
      const raw = await readFile(path.join(ROOT, 'node_modules/@fontsource/inter', weight + '.css'), 'utf8');
      fontCSS += raw.replace(/url\(\.\/files\/([^)]*\.woff2)\) format\('woff2'\), url\([^)]+\) format\('woff'\)/g, (_, font) => "url('./fonts/" + font + "') format('woff2')");
      for (const match of fontCSS.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)) {
        await save('assets/fonts/' + match[1], await readFile(path.join(ROOT, 'node_modules/@fontsource/inter/files', match[1])));
      }
    }
    const fontLink = /<link\b[^>]*href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter:wght@400;600;700&display=swap"[^>]*>/;
    if (!fontLink.test(head)) throw new Error('Cambió la fuente web: revisar pesos/subsets.');
    head = head.replace(fontLink, '<link rel="stylesheet" href="./assets/app.css" />');
    head = head.replace(/<!-- CDN con version EXACTA[\s\S]*?-->/, '<!-- Generado desde index.html. Editar la fuente y ejecutar npm run build. -->');
    head = head.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n  <meta http-equiv="Content-Security-Policy" content="' + CSP + '" />');
    await save('assets/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#b00020"/><text x="16" y="24" text-anchor="middle" font-family="sans-serif" font-size="25" font-weight="700" fill="white">F</text></svg>\n');
    head = head.replace('<title>', '<link rel="icon" href="./assets/favicon.svg" type="image/svg+xml" />\n  <title>');
    html = head + html.slice(headEnd);
    const css = await postcss([tailwindcss({ content: [{ raw: source.toString('utf8'), extension: 'html' }], theme: { extend: {} }, plugins: [] })]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' + fontCSS + '\n' + inlineStyles.join('\n'), { from: undefined, map: false });
    await save('assets/app.css', css.css + '\n');
    await save('index.html', html);
    // Mantener licencias propias; también las dependencias instaladas que nutren los bundles.
    const licenseParts = [];
    for (const [key, entry] of Object.entries(lock.packages).sort(([a], [b]) => a < b ? -1 : 1)) {
      if (!key || entry.dev || entry.optional) continue;
      const dir = path.join(ROOT, key);
      let names; try { names = await readdir(dir); } catch { continue; }
      for (const name of names.filter(n => /^(?:licen[cs]e|copying|ofl|notice)(?:[.\-_]|$)/i.test(n)).sort()) {
        try { licenseParts.push('\n===== ' + key + '@' + entry.version + '/' + name + ' =====\n' + await readFile(path.join(dir, name), 'utf8')); } catch {}
      }
    }
    await save('assets/THIRD-PARTY-LICENSES.txt', licenseParts.join('\n') + '\n');
    // El inventario embebido sale del bundle que realmente se sirve, no del publicado.
    const embeddedMammoth = Object.entries(repackaged.mammoth?.embeddedPackages || {}).flatMap(([name, versions]) => versions.map(version => ({ name, version })));
    if (!embeddedMammoth.length) throw new Error('Falta el inventario embebido del bundle de Mammoth.');
    const manifest = {
      schemaVersion: 1,
      application: { name: pkg.name, version: pkg.version },
      inputs: { 'index.html': hash(source), 'package.json': hash(await readFile(path.join(ROOT, 'package.json'))), 'package-lock.json': hash(lockBytes) },
      buildTools: pkg.devDependencies,
      runtimePackages: { ...runtime, '@fontsource/inter': pkg.dependencies['@fontsource/inter'] },
      vendorAssets: localAssets,
      embeddedInventory: { mammoth: embeddedMammoth, limitation: 'El lock npm no prueba versiones internas de bundles precompilados. Mammoth se reconstruye aquí con sus transitivas parcheadas; pdfmake/docx siguen siendo bundles upstream y deben auditarse por bytes/SRI y por su propio árbol, no asumir audit=0.' },
      repackagedBundles: repackaged,
      security: { csp: CSP, pdfJsEvalDisabledInSource: /getDocument\(\{[^}]*isEvalSupported:\s*false/.test(app), limitations: ['PDF.js ' + runtime['pdfjs-dist'] + ' incluye el parche de GHSA-wgrm-67xf-hhpq (>=4.2.67) y conserva isEvalSupported:false más CSP sin unsafe-eval.', 'Mammoth ' + runtime.mammoth + ' se sirve como bundle reconstruido con @xmldom/xmldom, jszip y underscore parcheados; verificar con npm run audit:dependencies.', 'docx y pdfmake se sirven como bundles upstream: su contenido interno no lo prueba el lock npm.', 'El build no certifica seguridad ni elimina los límites de tamaño descomprimido/DoS de documentos.'] },
      files: {},
    };
    if (!manifest.security.pdfJsEvalDisabledInSource) throw new Error('Se perdió el workaround obligatorio isEvalSupported:false para PDF.js.');
    for (const file of await listFiles(stage)) { const bytes = await readFile(path.join(stage, file)); manifest.files[file] = { bytes: bytes.length, sha256: hash(bytes), integrity: sri(bytes) }; }
    await save('build-manifest.json', stableJSON(manifest));
    if (hash(await readFile(path.join(ROOT, 'index.html'))) !== manifest.inputs['index.html']) throw new Error('index.html cambió durante el build. Repetir sobre la fuente final.');
    await rm(outDir, { recursive: true, force: true });
    await rename(stage, outDir);
    console.log('Build estático: ' + Object.keys(manifest.files).length + ' archivos + manifest; source SHA256 ' + manifest.inputs['index.html']);
    return manifest;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildProduction();
