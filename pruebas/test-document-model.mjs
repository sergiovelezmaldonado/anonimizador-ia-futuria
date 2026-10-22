import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(process.env.LOCALAPPDATA || path.join(path.dirname(path.dirname(root)), 'AppData', 'Local'), 'hermes', 'cache', 'scratch');
const snippetPath = path.join(scratch, 'text-document-model.js');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const region = html.match(/\/\/ ─── Modelo de documentos textuales[^\n]*\n([\s\S]*?)\/\/ ─── Fin modelo de documentos textuales[^\n]*/);
const sourcePath = process.env.FUTURIA_TEXT_MODEL || (region ? path.join(root, 'index.html') : snippetPath);
const source = process.env.FUTURIA_TEXT_MODEL ? fs.readFileSync(sourcePath, 'utf8') : region ? region[0] : fs.existsSync(snippetPath) ? fs.readFileSync(snippetPath, 'utf8') : '';
const apiNames = ['makeTextDocument', 'cleanTextDocument', 'parseTextDocumentJSON', 'serializeTextDocument', 'remapTextDocument', 'textDocumentRuns', 'readTextDocumentFile'];
function load(extra = {}) {
  const context = vm.createContext({ console, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, ...extra });
  vm.runInContext(source, context, { filename: sourcePath, timeout: 2000 });
  return { context, api: Object.fromEntries(apiNames.map(name => [name, vm.runInContext(`typeof ${name} === 'function' ? ${name} : undefined`, context)])) };
}
const plain = value => JSON.parse(JSON.stringify(value));
const { api } = load();
console.log('Modelo bajo prueba:', path.relative(root, sourcePath));

test('plain: texto canónico exacto y párrafos vacíos, incluidos CRLF y Unicode', () => {
  assert.equal(typeof api.makeTextDocument, 'function', 'Falta makeTextDocument');
  for (const text of ['', '\n', '\n\n', '\r\nA\r\n\r\nB\r\n', '  A\t \n\n B \n', '😀 e\u0301\rFin\n']) {
    const model = api.makeTextDocument(text);
    assert.equal(model.text, text);
    const pieces = text.split(/\r\n|\r|\n/);
    assert.equal(model.blocks.length, pieces.length);
    assert.deepEqual(plain(model.blocks.map(b => text.slice(b.start, b.end))), pieces);
    assert.ok(model.blocks.every(b => b.kind === 'paragraph' && b.runs.length === 0));
    assert.equal(model.blocks[0].start, 0);
    assert.equal(model.blocks.at(-1).end, text.length);
  }
  assert.throws(() => api.makeTextDocument(null), /texto|string/i);
});

test('JSON: schema fijo, whitelist, rechazo de llaves/backups/offsets inválidos y roundtrip exacto', () => {
  assert.equal(typeof api.serializeTextDocument, 'function', 'Falta serializeTextDocument');
  assert.equal(typeof api.parseTextDocumentJSON, 'function', 'Falta parseTextDocumentJSON');
  const model = api.makeTextDocument('\n Cabecera\r\n\r\n[PERSONA_1]\n');
  model.blocks[1].kind = 'heading';
  model.blocks[1].level = 3;
  model.blocks[1].runs = [{ start: 2, end: 5, bold: true, original: 'SECRETO_DE_PRUEBA' }];
  model.url = 'https://invalid.test';
  for (const kind of ['anonymized', 'restored']) {
    const serialized = api.serializeTextDocument(model, kind);
    const envelope = JSON.parse(serialized);
    assert.deepEqual(Object.keys(envelope).sort(), ['document', 'format', 'kind', 'version']);
    assert.equal(envelope.format, 'futuria-text');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.kind, kind);
    assert.equal(serialized.includes('SECRETO_DE_PRUEBA'), false);
    assert.equal(serialized.includes('https://invalid.test'), false);
    assert.deepEqual(plain(api.parseTextDocumentJSON(serialized)), plain(api.cleanTextDocument(model)));
  }
  assert.throws(() => api.serializeTextDocument(model, 'backup'), /kind|tipo/i);
  const valid = { format: 'futuria-text', version: 1, kind: 'anonymized', document: api.makeTextDocument('ABC') };
  for (const bad of [
    { replacements: [{ original: 'SECRETO_DE_PRUEBA' }] }, [], null,
    { ...valid, format: 'futuria-backup' }, { ...valid, kind: 'key' }, { ...valid, version: '1' },
    { ...valid, backup: { original: 'SECRETO_DE_PRUEBA' } },
    { ...valid, document: { text: 'ABC', blocks: [{ start: 0, end: 3, kind: 'javascript', runs: [] }] } },
    { ...valid, document: { text: 'ABC', blocks: [{ start: 0, end: '3', kind: 'paragraph', runs: [] }] } },
    { ...valid, document: { text: 'ABC', blocks: [{ start: -1, end: 3, kind: 'paragraph', runs: [] }] } },
    { ...valid, document: { text: 'ABC', blocks: [{ start: 0.5, end: 3, kind: 'paragraph', runs: [] }] } },
    { ...valid, document: { text: 'ABC', blocks: [{ start: 0, end: 3, kind: 'paragraph', runs: [{ start: 0, end: 2, bold: 'SECRET' }] }] } },
  ]) assert.throws(() => api.parseTextDocumentJSON(JSON.stringify(bad)));
  const poisoned = JSON.stringify({ ...valid, document: { ...valid.document, original: 'SECRETO_DE_PRUEBA', __proto__: { injected: true } } });
  assert.equal(JSON.stringify(api.parseTextDocumentJSON(poisoned)).includes('SECRETO_DE_PRUEBA'), false);
  assert.throws(() => api.parseTextDocumentJSON('{not-json'));
  assert.throws(() => api.parseTextDocumentJSON(' '.repeat(25 * 1024 * 1024 + 1)), /límite|grande/i);
});

test('runs: huecos y solapamientos cubren el bloque una sola vez, sin duplicar ni omitir', () => {
  assert.equal(typeof api.textDocumentRuns, 'function', 'Falta textDocumentRuns');
  const model = { text: 'p ABCDEF q', blocks: [] };
  const block = { start: 2, end: 8, kind: 'paragraph', runs: [{ start: 3, end: 6, bold: true }, { start: 5, end: 7, italic: true }] };
  const runs = api.textDocumentRuns(model, block);
  assert.equal(runs.map(r => r.text).join(''), 'ABCDEF');
  assert.deepEqual(plain(runs), [
    { text: 'A', bold: false, italic: false }, { text: 'BC', bold: true, italic: false },
    { text: 'D', bold: true, italic: true }, { text: 'E', bold: false, italic: true },
    { text: 'F', bold: false, italic: false },
  ]);
  assert.deepEqual(plain(api.textDocumentRuns(model, { ...block, end: 2, runs: [] })), []);
  assert.equal(api.textDocumentRuns(model, { ...block, runs: [{ start: -1, end: 500 }] }).map(r => r.text).join(''), 'ABCDEF');
  assert.throws(() => api.textDocumentRuns(model, { ...block, start: '2' }));
});

test('remap: reemplazo largo/corto cruza runs sin repetir/sufijar datos; prueba exacta de edits', () => {
  assert.equal(typeof api.remapTextDocument, 'function', 'Falta remapTextDocument');
  const secret = 'SECRETO_DE_PRUEBA';
  const text = `AA ${secret} ZZ\nOtro final`;
  const start = text.indexOf(secret), end = start + secret.length;
  const model = api.makeTextDocument(text);
  model.blocks[0].kind = 'heading';
  model.blocks[0].level = 2;
  model.blocks[0].runs = [{ start: 0, end: start + 6, bold: true }, { start: start + 6, end: model.blocks[0].end, italic: true, original: secret }];
  for (const replacement of ['[PERSONA_12345678901234567890]', 'X', '']) {
    const out = text.slice(0, start) + replacement + text.slice(end);
    const edits = [{ start, end, replacement }];
    const result = api.remapTextDocument(model, out, edits);
    assert.equal(result.text, out);
    assert.equal(result.blocks[0].kind, 'heading');
    assert.equal(result.blocks[0].level, 2);
    assert.equal(result.blocks[1].start, out.indexOf('Otro'));
    assert.equal(result.blocks[1].end, out.length);
    assert.equal(api.textDocumentRuns(result, result.blocks[0]).map(r => r.text).join(''), out.split('\n')[0]);
    const json = api.serializeTextDocument(result, 'anonymized');
    assert.equal(json.includes(secret), false);
    assert.equal(json.includes('SECRETO'), false);
    const pieces = api.textDocumentRuns(result, result.blocks[0]);
    assert.equal(pieces[0].text, 'AA ');
    assert.equal(pieces[0].bold, true);
    assert.equal(pieces.at(-1).text, ' ZZ');
    assert.equal(pieces.at(-1).italic, true);
    if (replacement) assert.equal(pieces.filter(r => r.text === replacement).length, 1);
    assert.deepEqual(plain(api.parseTextDocumentJSON(json)), plain(result));
  }
  assert.deepEqual(plain(api.remapTextDocument(model, text, [])), plain(api.cleanTextDocument(model)));
  assert.throws(() => api.remapTextDocument(model, 'salida no demostrada', [{ start, end, replacement: 'X' }]), /coincid|edits|salida/i);
  for (const edits of [
    [{ start: '3', end, replacement: 'X' }], [{ start: -1, end, replacement: 'X' }],
    [{ start, end: text.length + 1, replacement: 'X' }], [{ start, end, replacement: 3 }],
    [{ start: 5, end: 8, replacement: 'X' }, { start: 4, end: 6, replacement: 'Y' }],
    [{ start: 3, end: 8, replacement: 'X' }, { start: 7, end: 10, replacement: 'Y' }],
  ]) assert.throws(() => api.remapTextDocument(model, text, edits));
  const uniform = { text: 'ABCDEF', blocks: [{ start: 0, end: 6, kind: 'paragraph', runs: [{ start: 0, end: 6, bold: true }] }] };
  const mapped = api.remapTextDocument(uniform, 'AXXF', [{ start: 1, end: 5, replacement: 'XX' }]);
  assert.deepEqual(plain(mapped.blocks[0].runs), [{ start: 0, end: 4, bold: true }]);
});

test('remap: cruzar bloques o insertar saltos descarta formato, no texto', () => {
  assert.equal(typeof api.remapTextDocument, 'function', 'Falta remapTextDocument');
  const source = api.makeTextDocument('ab\n\ncd\n');
  source.blocks[0].kind = 'heading';
  const edit = { start: 1, end: 5, replacement: '[DATO_1]' };
  const out = source.text.slice(0, edit.start) + edit.replacement + source.text.slice(edit.end);
  assert.deepEqual(plain(api.remapTextDocument(source, out, [edit])), plain(api.makeTextDocument(out)));
  const newline = { start: 1, end: 2, replacement: '\nX\n' };
  const output = source.text.slice(0, 1) + newline.replacement + source.text.slice(2);
  assert.deepEqual(plain(api.remapTextDocument(source, output, [newline])), plain(api.makeTextDocument(output)));
});

test('remap: límite se aplica a salida final, no al saldo intermedio de edits', () => {
  const text = 'A'.repeat(25 * 1024 * 1024);
  const model = api.makeTextDocument(text);
  const edits = [{ start: 0, end: 0, replacement: 'X' }, { start: text.length - 1, end: text.length, replacement: '' }];
  const out = 'X' + text.slice(0, -1);
  assert.equal(api.remapTextDocument(model, out, edits).text, out);
});

test('roundtrip completo: múltiples bloques/editados, JSON etiquetado y restauración sin llave en metadata', () => {
  const secret = 'SECRETO_DE_PRUEBA';
  const text = `\nA ${secret} B\n\nC ${secret} D\n`;
  const source = api.makeTextDocument(text);
  source.blocks[1].kind = 'heading'; source.blocks[1].level = 1;
  source.blocks[1].runs = [{ start: source.blocks[1].start, end: source.blocks[1].end, bold: true }];
  source.blocks[3].runs = [{ start: source.blocks[3].start, end: source.blocks[3].end, italic: true }];
  const edits = [...text.matchAll(new RegExp(secret, 'g'))].map((match, index) => ({ start: match.index, end: match.index + secret.length, replacement: `[PERSONA_${index + 1}]` }));
  let cursor = 0, out = '';
  for (const edit of edits) { out += text.slice(cursor, edit.start) + edit.replacement; cursor = edit.end; }
  out += text.slice(cursor);
  const anon = api.remapTextDocument(source, out, edits);
  assert.equal(anon.blocks.length, source.blocks.length);
  assert.deepEqual(plain(anon.blocks.map(b => [b.start, b.end])), plain(api.makeTextDocument(out).blocks.map(b => [b.start, b.end])));
  const json = api.serializeTextDocument(anon, 'anonymized');
  assert.equal(json.includes(secret), false);
  const imported = api.parseTextDocumentJSON(json);
  const restorationEdits = [...out.matchAll(/\[PERSONA_\d+\]/g)].map(match => ({ start: match.index, end: match.index + match[0].length, replacement: secret }));
  const restored = api.remapTextDocument(imported, text, restorationEdits);
  assert.equal(restored.text, text);
  assert.deepEqual(plain(restored), plain(api.cleanTextDocument(source)));
  const restorationJSON = api.serializeTextDocument(restored, 'restored');
  assert.equal(JSON.parse(restorationJSON).kind, 'restored');
  const metadata = JSON.parse(restorationJSON).document;
  delete metadata.text;
  assert.equal(JSON.stringify(metadata).includes(secret), false);
});

test('importación TXT/CSV/JSON: exactitud, límites previos a lectura y rechazo de formatos', async () => {
  assert.equal(typeof api.readTextDocumentFile, 'function', 'Falta readTextDocumentFile');
  for (const ext of ['txt', 'CSV']) {
    const text = '\ufeff\n A,\"B\"\r\n\r\n C \n';
    const file = new File([text], `sintetico.${ext}`);
    const result = await api.readTextDocumentFile(file);
    assert.equal(result.text, text);
    assert.equal(result.blocks.length, text.split(/\r\n|\r|\n/).length);
  }
  const model = api.makeTextDocument('\n[PERSONA_1]\n\n');
  const jsonFile = new File([api.serializeTextDocument(model, 'anonymized')], 'etiquetas.JSON');
  assert.deepEqual(plain(await api.readTextDocumentFile(jsonFile)), plain(model));
  await assert.rejects(api.readTextDocumentFile(new File(['{}'], 'llave.json')), /futuria-text|llave/i);
  let reads = 0;
  for (const size of [0, -1, NaN, Infinity, '5', 25 * 1024 * 1024 + 1]) {
    await assert.rejects(api.readTextDocumentFile({ name: 'datos.txt', size, text: async () => { reads++; return 'x'; } }));
  }
  assert.equal(reads, 0);
  const small = load({ MAX_FILE_BYTES: 3 }).api;
  await assert.rejects(small.readTextDocumentFile(new File(['ABCD'], 'datos.txt')), /máximo|límite|grande/i);
  await assert.rejects(api.readTextDocumentFile(new File(['ABCD'], 'datos.exe')), /compatible|formato/i);
});

test('TXT/CSV: UTF-8 inválido se rechaza en vez de sustituir contenido silenciosamente', async () => {
  for (const ext of ['txt', 'csv', 'json']) {
    await assert.rejects(api.readTextDocumentFile(new File([new Uint8Array([0xff, 0xfe, 0x41, 0x00])], `sintetico.${ext}`)), /UTF-8|codificación/i);
  }
});

test('PDF: valida firma y delega extractor existente; solo párrafos, sin estilos inventados', async () => {
  let calls = 0;
  const progress = [];
  const extracted = '\nLínea uno\n\nPárrafo final\n';
  const file = new File(['%PDF-1.7\ncontenido sintético'], 'sintetico.pdf');
  const pdfApi = load({ extractTextFromFile: async (incoming, callback) => {
    calls++;
    assert.equal(incoming, file);
    callback('avance sintético');
    return extracted;
  } }).api;
  const result = await pdfApi.readTextDocumentFile(file, message => progress.push(message));
  assert.equal(result.text, extracted);
  assert.ok(result.blocks.every(b => b.kind === 'paragraph' && b.runs.length === 0));
  assert.equal(calls, 1);
  assert.ok(progress.includes('avance sintético'));
  await assert.rejects(pdfApi.readTextDocumentFile(new File(['No es PDF'], 'renombrado.pdf')), /firma|PDF/i);
  assert.equal(calls, 1, 'firma inválida no llega al extractor');
  let loads = 0;
  const docApi = load({ loadMammoth: async () => { loads++; throw new Error('No cargar'); } }).api;
  for (const ext of ['doc', 'docx']) {
    await assert.rejects(docApi.readTextDocumentFile(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])], `legado.${ext}`)), /antiguo|97-2003/i);
    await assert.rejects(docApi.readTextDocumentFile(new File(['No es Word'], `renombrado.${ext}`)), /firma|DOCX/i);
  }
  assert.equal(loads, 0, 'rechaza firmas antes de cargar el motor');
});

// Dependencias de integración solo en scratch, nunca en package.json del padre.
// npm install --prefix <scratch>/text-document-test-deps --ignore-scripts mammoth@1.8.0 jsdom@26.1.0 pdfjs-dist@3.11.174
// FUTURIA_TEXT_MODEL=<archivo> fuerza el snippet; por defecto prefiere la región
// integrada entre marcadores. FUTURIA_REQUIRE_DOCUMENT_DEPS=1 prohíbe skips.
// FUTURIA_DOCUMENT_TEST_DEPS permite ubicar estas dependencias fuera de scratch.
const depsRoot = process.env.FUTURIA_DOCUMENT_TEST_DEPS || path.join(scratch, 'text-document-test-deps');
const requireDeps = createRequire(path.join(depsRoot, 'package.json'));
function browserDeps(t) {
  try { return { ...requireDeps('jsdom'), mammothBundle: fs.readFileSync(requireDeps.resolve('mammoth/mammoth.browser.js'), 'utf8') }; }
  catch (error) {
    if (process.env.FUTURIA_REQUIRE_DOCUMENT_DEPS === '1') throw error;
    t.skip('DOCX real requiere mammoth@1.8.0 + jsdom@26.1.0 en FUTURIA_DOCUMENT_TEST_DEPS');
    return null;
  }
}
function syntheticPdf() {
  const stream = 'BT /F1 12 Tf 30 360 Td (Linea uno) Tj 0 -16 Td (Linea dos) Tj 0 -16 Td (Linea tres) Tj 0 -48 Td (Parrafo final) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF real: ejecuta extractTextFromFile y reconstrucción del HTML con pdf.js fijado', async t => {
  let pdfjs;
  try { pdfjs = requireDeps('pdfjs-dist/build/pdf.js'); }
  catch (error) {
    if (process.env.FUTURIA_REQUIRE_DOCUMENT_DEPS === '1') throw error;
    t.skip('PDF real requiere pdfjs-dist@3.11.174 en FUTURIA_DOCUMENT_TEST_DEPS');
    return;
  }
  const extraction = html.match(/async function extractTextFromFile\([^]*?\n\}/)?.[0];
  const reconstruction = html.match(/function reconstructPageText\([^]*?\n\}/)?.[0];
  assert.ok(extraction && reconstruction, 'No se encontraron los helpers PDF existentes');
  const { context, api: realApi } = load({
    loadPdfJs: async () => ({ getDocument: options => {
      assert.equal(options.isEvalSupported, false);
      return pdfjs.getDocument({ ...options, standardFontDataUrl: path.join(path.dirname(requireDeps.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep });
    } }), MAX_FILE_BYTES: 25 * 1024 * 1024, MAX_FILE_MB: 25,
    MAX_PDF_PAGES: 300, AVISO_PAGINAS: 40, setTimeout,
  });
  vm.runInContext(reconstruction + '\n' + extraction, context);
  const result = await realApi.readTextDocumentFile(new File([syntheticPdf()], 'sintetico.pdf'));
  assert.equal(result.text, 'Linea uno\nLinea dos\nLinea tres\n\nParrafo final');
  assert.ok(result.blocks.every(block => block.kind === 'paragraph' && block.runs.length === 0));
  assert.deepEqual(plain(realApi.parseTextDocumentJSON(realApi.serializeTextDocument(result, 'restored'))), plain(result));
});

function zipStored(entries) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function syntheticDocx(body = null, extraStyles = '') {
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"';
  const list = (id, level, text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const levels = format => Array.from({ length: 6 }, (_, index) => `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${format === 'bullet' ? '•' : '%' + (index + 1) + '.'}"/></w:lvl>`).join('');
  return zipStored({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': body === null ? `<w:document ${ns}><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Título sintético</w:t></w:r></w:p><w:p/><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>A</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>B</w:t></w:r><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>C</w:t></w:r><w:r><w:br/><w:t>D</w:t></w:r></w:p>${list(1, 0, 'Uno')}${list(1, 1, 'Dos')}${list(2, 0, 'Tres')}<w:p><w:hyperlink r:id="link"><w:r><w:t>enlace visible</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:t>X</w:t></w:r><w:r><w:commentReference w:id="0"/></w:r></w:p><w:p><w:r><w:pict><v:shape><v:imagedata r:id="image"/></v:shape></w:pict></w:r></w:p><w:p/></w:body></w:document>` : `<w:document ${ns}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `<w:styles ${ns}><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>${extraStyles}</w:styles>`,
    'word/numbering.xml': `<w:numbering ${ns}><w:abstractNum w:abstractNumId="0">${levels('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1">${levels('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    'word/comments.xml': `<w:comments ${ns}><w:comment w:id="0" w:author="Metadata"><w:p><w:r><w:t>COMENTARIO_OCULTO_DE_PRUEBA</w:t></w:r></w:p></w:comment></w:comments>`,
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="num" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="comments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://invalid.test/ORIGINAL_OCULTO" TargetMode="External"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://invalid.test/TRACKER" TargetMode="External"/></Relationships>',
  });
}

test('DOCX real: títulos/listas/estilos/vacíos; sin imágenes, comentarios, atributos ni red', async t => {
  const deps = browserDeps(t);
  if (!deps) return;
  const requests = [];
  const dom = new deps.JSDOM('<!doctype html><html><body><div id="original">No tocar</div></body></html>', {
    url: 'https://document-test.invalid/', runScripts: 'outside-only',
    resources: new class extends deps.ResourceLoader { fetch(url) { requests.push(url); return null; } }(),
  });
  dom.window.TextDecoder = TextDecoder;
  dom.window.TextEncoder = TextEncoder;
  dom.window.eval(deps.mammothBundle);
  const bodyBefore = dom.window.document.body.innerHTML;
  const modelApi = load({ document: dom.window.document, loadMammoth: async () => dom.window.mammoth }).api;
  try {
    const bytes = syntheticDocx();
    const file = new File([bytes], 'sintetico.docx');
    // JSZip 3 del bundle browser usa instanceof: entrega bytes en su realm,
    // igual que File.arrayBuffer() en un navegador real (Node está en otro).
    file.arrayBuffer = async () => new dom.window.Uint8Array(bytes).buffer;
    const result = await modelApi.readTextDocumentFile(file);
    assert.equal(result.text, 'Título sintético\n\nABC\nD\n• Uno\n  • Dos\n1. Tres\nenlace visible\nX\n\n');
    assert.deepEqual(plain(result.blocks.map(b => [b.kind, b.level || null])), [
      ['heading', 2], ['paragraph', null], ['paragraph', null], ['bullet', 1], ['bullet', 2], ['numbered', 1], ['paragraph', null], ['paragraph', null], ['paragraph', null], ['paragraph', null],
    ]);
    assert.deepEqual(plain(modelApi.textDocumentRuns(result, result.blocks[2])), [
      { text: 'A', bold: true, italic: false }, { text: 'B', bold: false, italic: true },
      { text: 'C', bold: true, italic: true }, { text: '\nD', bold: false, italic: false },
    ]);
    const json = modelApi.serializeTextDocument(result, 'anonymized');
    assert.equal(/https:|ORIGINAL_OCULTO|TRACKER|COMENTARIO_OCULTO|Metadata|href|src/.test(json), false);
    assert.deepEqual(requests, []);
    assert.equal(dom.window.document.body.innerHTML, bodyBefore);
    assert.deepEqual(plain(modelApi.parseTextDocumentJSON(json)), plain(result));
  } finally { dom.window.close(); }
});

test('DOCX real: Title/Subtitle, Heading6 y Emphasis recuperan estructura/énfasis', async t => {
  const deps = browserDeps(t);
  if (!deps) return;
  const dom = new deps.JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.TextDecoder = TextDecoder;
  dom.window.TextEncoder = TextEncoder;
  dom.window.eval(deps.mammothBundle);
  const modelApi = load({ document: dom.window.document, loadMammoth: async () => dom.window.mammoth }).api;
  const paragraph = (style, value) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${value}</w:t></w:r></w:p>`;
  const body = paragraph('Title', 'Portada') + paragraph('Subtitle', 'Subtítulo') + paragraph('Heading6', 'Detalle') + '<w:p><w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>énfasis</w:t></w:r></w:p>';
  const styles = ['Title', 'Subtitle', 'Heading6'].map(id => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/></w:style>`).join('') + '<w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/></w:style>';
  const bytes = syntheticDocx(body, styles);
  const file = new File([bytes], 'sintetico.docx');
  file.arrayBuffer = async () => new dom.window.Uint8Array(bytes).buffer;
  try {
    const result = await modelApi.readTextDocumentFile(file);
    assert.equal(result.text, 'Portada\nSubtítulo\nDetalle\nénfasis');
    assert.deepEqual(plain(result.blocks.map(b => [b.kind, b.level || null])), [['heading', 1], ['heading', 2], ['heading', 6], ['paragraph', null]]);
    assert.deepEqual(plain(modelApi.textDocumentRuns(result, result.blocks[3])), [{ text: 'énfasis', bold: false, italic: true }]);
  } finally { dom.window.close(); }
});

test('DOCX real: listas con seis niveles conservan marcadores literales y niveles', async t => {
  const deps = browserDeps(t);
  if (!deps) return;
  const dom = new deps.JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.TextDecoder = TextDecoder;
  dom.window.TextEncoder = TextEncoder;
  dom.window.eval(deps.mammothBundle);
  const modelApi = load({ document: dom.window.document, loadMammoth: async () => dom.window.mammoth }).api;
  const body = [1, 2].flatMap(id => Array.from({ length: 6 }, (_, level) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr></w:pPr><w:r><w:t>Nivel ${level + 1}</w:t></w:r></w:p>`)).join('');
  const bytes = syntheticDocx(body);
  const file = new File([bytes], 'sintetico.docx');
  file.arrayBuffer = async () => new dom.window.Uint8Array(bytes).buffer;
  try {
    const result = await modelApi.readTextDocumentFile(file);
    const expected = ['bullet', 'numbered'].flatMap(kind => Array.from({ length: 6 }, (_, index) => ({ kind, level: index + 1, text: '  '.repeat(index) + (kind === 'bullet' ? '• ' : '1. ') + `Nivel ${index + 1}` })));
    assert.deepEqual(plain(result.blocks.map(b => ({ kind: b.kind, level: b.level, text: result.text.slice(b.start, b.end) }))), expected);
    assert.equal(result.text, expected.map(b => b.text).join('\n'));
  } finally { dom.window.close(); }
});

test('DOCX HTML hostil: template inerte, sin recursos/attrs y listas vacías en orden', async t => {
  const deps = browserDeps(t);
  if (!deps) return;
  const requests = [];
  const dom = new deps.JSDOM('<!doctype html><body><p id="sentinel">Intacto</p></body>', {
    url: 'https://document-test.invalid/', runScripts: 'dangerously',
    resources: new class extends deps.ResourceLoader { fetch(url) { requests.push(url); return null; } }(),
  });
  dom.window.__executed = 0;
  const before = dom.window.document.documentElement.outerHTML;
  const unsafe = '<h3 onclick="window.__executed=1" data-original="SECRETO"><strong>Título &amp;</strong> <em>itálica</em></h3><p></p><ol start="99"><li><p>Primero</p><p>Continuación</p><ul><li><p>Hijo</p></li></ul>cola</li><li></li><li><ul><li>Solo anidado</li></ul></li></ol><p>Texto <a href="javascript:window.__executed=1" title="SECRETO">visible</a><br>final</p><p></p><img src="https://invalid.test/TRACKER" onerror="window.__executed=1" alt="SECRETO"><link rel="stylesheet" href="https://invalid.test/TRACKER"><iframe src="https://invalid.test/TRACKER">SECRETO</iframe><script>window.__executed=1</script><style>SECRETO</style><!-- SECRETO -->';
  const modelApi = load({ document: dom.window.document, loadMammoth: async () => ({ convertToHtml: async (input, options) => {
    assert.ok(input.arrayBuffer instanceof ArrayBuffer);
    assert.equal(options.ignoreEmptyParagraphs, false);
    assert.equal(options.includeEmbeddedStyleMap, false);
    assert.deepEqual(plain(await options.convertImage({ read() { throw new Error('No leer imágenes'); } })), []);
    return { value: unsafe };
  } }) }).api;
  try {
    const result = await modelApi.readTextDocumentFile(new File(['PK'], 'sintetico.docx'));
    assert.equal(result.text, 'Título & itálica\n\n1. Primero\nContinuación\n  • Hijo\ncola\n2. \n3. \n  • Solo anidado\nTexto visible\nfinal\n');
    assert.equal(modelApi.serializeTextDocument(result, 'anonymized').includes('SECRETO'), false);
    assert.equal(dom.window.__executed, 0);
    assert.deepEqual(requests, []);
    assert.equal(dom.window.document.documentElement.outerHTML, before);
  } finally { dom.window.close(); }
});

test('remap: 256 combinaciones deterministas concuerdan con referencia por carácter', () => {
  let seed = 0x5eed;
  const next = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let iteration = 0; iteration < 256; iteration++) {
    const text = 'abcdefghijklmnopqrstuvwx';
    const styles = Array.from(text, () => ({ bold: next(3) === 0, italic: next(3) === 0 }));
    const model = { text, blocks: [{ start: 0, end: text.length, kind: 'heading', level: 4,
      runs: styles.flatMap((style, start) => style.bold || style.italic ? [{ start, end: start + 1, ...style }] : []) }] };
    const edits = [];
    let sourceCursor = 0;
    while (sourceCursor <= text.length && edits.length < 5) {
      const start = Math.min(text.length, sourceCursor + next(4));
      const end = Math.min(text.length, start + next(5));
      edits.push({ start, end, replacement: 'X'.repeat(next(8)) });
      sourceCursor = end + 1;
    }
    let cursor = 0, out = '';
    const expected = [];
    for (const edit of edits) {
      out += text.slice(cursor, edit.start) + edit.replacement;
      expected.push(...styles.slice(cursor, edit.start));
      const sourceStyles = edit.start === edit.end ? [styles[edit.start] || styles.at(-1)] : styles.slice(edit.start, edit.end);
      const common = { bold: sourceStyles.every(s => s.bold), italic: sourceStyles.every(s => s.italic) };
      expected.push(...Array.from(edit.replacement, () => common));
      cursor = edit.end;
    }
    out += text.slice(cursor);
    expected.push(...styles.slice(cursor));
    const result = api.remapTextDocument(model, out, edits);
    const runs = api.textDocumentRuns(result, result.blocks[0]);
    assert.equal(runs.map(r => r.text).join(''), out, `texto, caso ${iteration}`);
    const actual = runs.flatMap(run => Array.from(run.text, () => ({ bold: run.bold, italic: run.italic })));
    assert.deepEqual(plain(actual), expected, `estilos, caso ${iteration}`);
    assert.equal(result.blocks[0].kind, 'heading');
  }
});

test('JSON hostil: prototipos/ciclos en metadata se eliminan y hay límites de bloques/runs', () => {
  const text = 'A';
  const model = { text, blocks: [{ start: 0, end: 1, kind: 'paragraph', runs: [] }] };
  model.original = model;
  model.blocks[0].href = 'https://invalid.test/SECRETO_DE_PRUEBA';
  const json = api.serializeTextDocument(model, 'anonymized');
  assert.equal(/href|https:|original|SECRETO_DE_PRUEBA/.test(json), false);
  const raw = '{"format":"futuria-text","version":1,"kind":"anonymized","document":{"__proto__":{"polluted":true},"text":"A","blocks":[{"start":0,"end":1,"kind":"paragraph","runs":[],"original":"SECRETO_DE_PRUEBA"}]}}';
  assert.deepEqual(plain(api.parseTextDocumentJSON(raw)), plain(api.makeTextDocument(text)));
  assert.equal({}.polluted, undefined);
  for (const bad of [
    { text, blocks: Array(100001).fill(model.blocks[0]) },
    { text, blocks: [{ ...model.blocks[0], runs: Array(250001).fill({ start: 0, end: 1, bold: true }) }] },
    { text, blocks: [{ ...model.blocks[0], runs: [{ start: 0, end: 1, italic: 1 }] }] },
  ]) {
    assert.equal(api.cleanTextDocument(bad).text, text);
    assert.throws(() => api.parseTextDocumentJSON(JSON.stringify({ format: 'futuria-text', version: 1, kind: 'anonymized', document: bad })));
  }
  assert.throws(() => api.makeTextDocument('A'.repeat(25 * 1024 * 1024 + 1)), /límite/i);
  assert.throws(() => api.makeTextDocument('\n'.repeat(100000)), /párrafos/i);
});

test('clean: solo offsets/tipos/estilos; los spans solapados se normalizan sin texto oculto', () => {
  assert.equal(typeof api.cleanTextDocument, 'function', 'Falta cleanTextDocument');
  const source = {
    text: 'ABCDEF', original: 'SECRETO_DE_PRUEBA', url: 'https://invalid.test',
    blocks: [{ start: 0, end: 6, kind: 'heading', level: 2, original: 'SECRETO_DE_PRUEBA',
      runs: [{ start: 0, end: 4, bold: true, text: 'SECRETO_DE_PRUEBA' }, { start: 2, end: 5, italic: true, href: 'https://invalid.test' }] }],
  };
  const before = JSON.stringify(source);
  const clean = api.cleanTextDocument(source);
  assert.deepEqual(plain(clean), { text: 'ABCDEF', blocks: [{ start: 0, end: 6, kind: 'heading', level: 2,
    runs: [{ start: 0, end: 2, bold: true }, { start: 2, end: 4, bold: true, italic: true }, { start: 4, end: 5, italic: true }] }] });
  assert.equal(JSON.stringify(source), before, 'no muta el modelo recibido');
  for (const bad of [
    { ...source, blocks: [{ start: '0', end: 6, kind: 'paragraph', runs: [] }] },
    { ...source, blocks: [{ start: 0, end: 6, kind: 'script', runs: [] }] },
    { ...source, blocks: [{ start: 0, end: 6, kind: 'heading', level: 7, runs: [] }] },
    { ...source, blocks: [{ start: 0, end: 6, kind: 'paragraph', runs: [{ start: 0, end: 7, bold: true }] }] },
    { ...source, blocks: [{ start: 1, end: 6, kind: 'paragraph', runs: [] }] },
    { ...source, blocks: [] },
  ]) assert.deepEqual(plain(api.cleanTextDocument(bad)), plain(api.makeTextDocument(source.text)));
  assert.throws(() => api.cleanTextDocument({ text: 15, blocks: [] }), /texto|string/i);
});
