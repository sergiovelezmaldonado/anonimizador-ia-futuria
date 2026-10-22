import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const snippetPath = 'index.html:exportación textual';
const snippet = html.match(/\/\/ ─── Exportación textual multiformato[\s\S]*?\/\/ ─── Fin exportación textual multiformato/)[0];
const vendorDir = process.env.FUTURIA_EXPORT_TEST_DEPS || path.join(process.env.LOCALAPPDATA,'hermes','cache','scratch');
function fixture(overrides = {}) {
    const events = [], scripts = [], timers = [];
    const context = {
        Blob, URL, console, Date,
        setTimeout, clearTimeout,
        cleanTextDocument(model) { return model; },
        makeTextDocument(text) { return { text, blocks: [] }; },
        serializeTextDocument(model, kind) { return JSON.stringify({ version: 1, kind, ...model }); },
        textDocumentRuns(model, block) {
            const points = new Set([block.start, block.end]);
            for (const run of block.runs || []) { points.add(run.start); points.add(run.end); }
            const offsets = [...points].sort((a, b) => a - b);
            return offsets.slice(0, -1).map((start, i) => {
                const end = offsets[i + 1];
                const styles = (block.runs || []).filter(r => r.start <= start && r.end >= end);
                return { text: model.text.slice(start, end), bold: styles.some(r => r.bold), italic: styles.some(r => r.italic) };
            });
        },
        dispatchEvent(event) { events.push(event); },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        document: {
            head: { appendChild(script) { scripts.push(script); queueMicrotask(() => script.onload?.()); } },
            body: { appendChild() {} },
            createElement(tag) { return { tagName: tag, remove() {}, click() {} }; },
        },
        ...overrides,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(snippet, context, { filename: snippetPath });
    return { context, events, scripts, timers };
}
const sample = () => ({
    text: 'Título áéíóú ñ\r\n\r\n• Uno\tDos\n2. Tres\nLiteral **sin Markdown**\n',
    blocks: [], sourceName: 'Nombre-Secreto-Apellido.docx', original: 'ORIGINAL-SECRETO',
    reps: [{ from: 'ORIGINAL-SECRETO', to: 'PERSONA_1' }], key: 'LLAVE-SECRETA',
});
test('TXT preserves exact Unicode, tabs, CRLF and trailing newlines without loading libraries', async () => {
    const { context, scripts } = fixture();
    const model = sample();
    const blob = await context.buildTextDocumentBlob(model, 'txt');
    assert.equal(blob.type, 'text/plain;charset=utf-8');
    assert.equal(await blob.text(), model.text);
    assert.equal(scripts.length, 0);
});
test('JSON calls serializer only with the clean whitelisted model and explicit kind', async () => {
    let received;
    const { context, scripts } = fixture({ serializeTextDocument(model, kind) { received = { model, kind }; return JSON.stringify({ kind, ...model }); } });
    const model = sample();
    const blob = await context.buildTextDocumentBlob(model, 'json', 'restored');
    const output = await blob.text();
    assert.equal(blob.type, 'application/json;charset=utf-8');
    assert.equal(received.kind, 'restored');
    assert.deepEqual(Object.keys(received.model).sort(), ['blocks', 'text']);
    assert.equal(JSON.parse(output).text, model.text);
    for (const forbidden of ['ORIGINAL-SECRETO', 'LLAVE-SECRETA', 'Nombre-Secreto-Apellido', 'sourceName', 'reps']) assert.ok(!output.includes(forbidden), forbidden);
    assert.equal(scripts.length, 0);
});
test('invalid kind and format fail before loading libraries', async () => {
    const { context, scripts } = fixture();
    await assert.rejects(context.buildTextDocumentBlob(sample(), 'doc', 'anonymized'), /formato/i);
    await assert.rejects(context.buildTextDocumentBlob(sample(), 'txt', 'original'), /tipo/i);
    assert.equal(scripts.length, 0);
});
test('lazy loader deduplicates concurrent requests and uses a JS-compatible pinned DOCX URL with SRI', async () => {
    const f = fixture();
    const api = { Document: class {}, Paragraph: class {}, TextRun: class {}, Tab: class {}, Packer: { toBlob() {} } };
    f.context.document.head.appendChild = script => {
        f.scripts.push(script);
        queueMicrotask(() => { f.context.docx = api; script.onload(); });
    };
    const [a, b] = await Promise.all([f.context.loadTextExportLibraries('docx'), f.context.loadTextExportLibraries('docx')]);
    assert.equal(a, b);
    assert.equal(f.scripts.length, 1);
    assert.equal(f.scripts[0].src, 'https://unpkg.com/docx@9.5.1/dist/index.umd.cjs');
    assert.match(f.scripts[0].integrity, /^sha384-/);
    assert.equal(f.scripts[0].referrerPolicy, 'no-referrer');
});
test('lazy loader clears rejected promises so a later retry can succeed', async () => {
    const f = fixture();
    let attempt = 0;
    f.context.document.head.appendChild = script => {
        f.scripts.push(script);
        queueMicrotask(() => {
            if (++attempt === 1) script.onerror();
            else { f.context.docx = { Document: class {}, Paragraph: class {}, TextRun: class {}, Packer: { toBlob() {} } }; script.onload(); }
        });
    };
    await assert.rejects(f.context.loadTextExportLibraries('docx'), /cargar/i);
    assert.ok(await f.context.loadTextExportLibraries('docx'));
    assert.equal(f.scripts.length, 2);
});
function zipEntries(bytes) {
    const buffer = Buffer.from(bytes);
    let eocd = buffer.length - 22;
    while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    assert.ok(eocd >= 0, 'valid ZIP end record');
    const entries = new Map();
    let offset = buffer.readUInt32LE(eocd + 16);
    const count = buffer.readUInt16LE(eocd + 10);
    for (let i = 0; i < count; i++) {
        assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
        const compression = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
        const nameLen = buffer.readUInt16LE(offset + 28), extraLen = buffer.readUInt16LE(offset + 30), commentLen = buffer.readUInt16LE(offset + 32);
        const local = buffer.readUInt32LE(offset + 42), name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString();
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const data = buffer.subarray(start, start + size);
        entries.set(name, compression === 8 ? inflateRawSync(data).toString() : data.toString());
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}
function richSample() {
    const model = sample();
    const firstEnd = model.text.indexOf('\r');
    const bulletStart = model.text.indexOf('•'), bulletEnd = model.text.indexOf('\n2.');
    model.blocks = [
        { start: 0, end: firstEnd, kind: 'heading', level: 1, runs: [{ start: 0, end: firstEnd, bold: true, original: 'ORIGINAL-SECRETO' }] },
        { start: bulletStart, end: bulletEnd, kind: 'bullet', level: 0, runs: [{ start: bulletStart + 2, end: bulletStart + 5, italic: true }] },
        { start: bulletEnd + 1, end: model.text.indexOf('\nLiteral'), kind: 'numbered', runs: [] },
    ];
    return model;
}
test('DOCX uses real native paragraphs, blank lines, tabs, heading and styled runs without stale text or private metadata', async () => {
    const f = fixture({ setImmediate, clearImmediate, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder });
    vm.runInContext(fs.readFileSync(path.join(vendorDir, 'text-export-vendor-docx.js'), 'utf8'), f.context);
    const model = richSample();
    const blob = await f.context.buildTextDocumentBlob(model, 'docx');
    assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const bytes = await blob.arrayBuffer();
    const entries = zipEntries(bytes);
    const xml = entries.get('word/document.xml');
    assert.ok(xml.includes('Heading1'));
    assert.ok(xml.includes('<w:i'));
    assert.ok(xml.includes('<w:b'));
    assert.ok(xml.includes('<w:tab/>'));
    assert.equal((xml.match(/<w:p[ >]/g) || []).length, model.text.split(/\r\n|\r|\n/).length);
    assert.ok(xml.includes('Literal **sin Markdown**'));
    assert.ok(!xml.includes('<w:numPr>'), 'do not insert duplicate list markers');
    const all = [...entries.values()].join('\n');
    for (const forbidden of ['ORIGINAL-SECRETO', 'LLAVE-SECRETA', 'Nombre-Secreto-Apellido']) assert.ok(!all.includes(forbidden), forbidden);
    fs.writeFileSync(path.join(vendorDir, 'text-export-real.docx'), Buffer.from(bytes));
});
test('save uses generic local-date filenames, clicks a blob download and revokes the object URL later', async () => {
    const calls = [], pending = [];
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [2026, 9, 22, 12])); } }
    const f = fixture({
        Date: FixedDate,
        URL: { createObjectURL(blob) { calls.push({ event: 'create', blob }); return 'blob:test-export'; }, revokeObjectURL(url) { calls.push({ event: 'revoke', url }); } },
        setTimeout(fn, ms) { pending.push({ fn, ms }); return pending.length; }, clearTimeout() {},
    });
    f.context.document.createElement = () => ({ remove() { calls.push({ event: 'remove' }); }, click() { calls.push({ event: 'click', name: this.download, href: this.href }); } });
    const name = await f.context.saveTextDocument(sample(), 'txt', 'restored', { canSave: () => true });
    assert.equal(name, 'texto-restaurado-CONFIDENCIAL-2026-10-22.txt');
    assert.equal(calls.find(x => x.event === 'click').name, name);
    assert.equal(calls.find(x => x.event === 'click').href, 'blob:test-export');
    assert.ok(!JSON.stringify(calls).includes('Nombre-Secreto-Apellido'));
    assert.equal(await calls[0].blob.text(), sample().text);
    assert.equal(calls.filter(x => x.event === 'revoke').length, 0);
    assert.ok(pending.some(x => x.ms >= 10000));
    for (const timer of pending) timer.fn();
    assert.equal(calls.filter(x => x.event === 'revoke').length, 1);
});
test('save rechecks canSave after asynchronous generation and never creates a stale download', async () => {
    let allowed = true, resolveBlob;
    const calls = [];
    const f = fixture({ URL: { createObjectURL() { calls.push('create'); return 'blob:stale'; }, revokeObjectURL() {} } });
    f.context.buildTextDocumentBlob = () => new Promise(resolve => { resolveBlob = resolve; });
    const saving = f.context.saveTextDocument(sample(), 'txt', 'anonymized', { canSave: () => allowed });
    allowed = false;
    resolveBlob(new Blob(['text']));
    await assert.rejects(saving, { message: 'El resultado cambió durante la preparación. Revisa el texto y vuelve a descargar.' });
    assert.deepEqual(calls, []);
});
function realPdfFixture() {
    const f = fixture({ setImmediate, clearImmediate, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, navigator: { userAgent: 'export-node-test' } });
    f.context.window = f.context;
    f.context.self = f.context;
    f.context.document.head.appendChild = script => {
        f.scripts.push(script);
        queueMicrotask(() => {
            try {
                const key = script.src.includes('vfs_fonts') ? 'vfs_fonts' : 'pdfmake';
                vm.runInContext(fs.readFileSync(path.join(vendorDir, 'text-export-vendor-' + key + '.js'), 'utf8'), f.context);
                script.onload();
            } catch (error) { console.error(error); script.onerror?.(); }
        });
    };
    return f;
}
test('PDF uses real pdfmake getBlob, embedded Roboto styles and selectable text without a canvas', async () => {
    const f = realPdfFixture();
    const blob = await f.context.buildTextDocumentBlob(richSample(), 'pdf');
    assert.equal(blob.type, 'application/pdf');
    const bytes = Buffer.from(await blob.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.ok(bytes.length > 10000);
    assert.equal(f.scripts.length, 2);
    fs.writeFileSync(path.join(vendorDir, 'text-export-real.pdf'), bytes);
});
test('build publishes a privacy-safe loading-to-complete lifecycle for parent progress UI', async () => {
    const f = realPdfFixture();
    await f.context.buildTextDocumentBlob(richSample(), 'pdf', 'restored');
    const events = f.events.filter(e => e.type === 'text-document-export-progress').map(e => e.detail);
    assert.equal(events[0].phase, 'loading');
    assert.equal(events.at(-1).phase, 'complete');
    assert.ok(events.some(e => e.phase === 'preparing'));
    assert.ok(events.some(e => e.phase === 'generating'));
    assert.ok(events.every(e => e.format === 'pdf' && e.kind === 'restored'));
    assert.ok(!JSON.stringify(events).includes('Título'));
    assert.ok(!JSON.stringify(events).includes('ORIGINAL-SECRETO'));
});
test('DOCX defines Normal and uses native list paragraph style without generating duplicate markers', async () => {
    const f = fixture({ setImmediate, clearImmediate, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder });
    vm.runInContext(fs.readFileSync(path.join(vendorDir, 'text-export-vendor-docx.js'), 'utf8'), f.context);
    const blob = await f.context.buildTextDocumentBlob(richSample(), 'docx');
    const entries = zipEntries(await blob.arrayBuffer());
    assert.ok(entries.get('word/styles.xml').includes('w:styleId="Normal"'));
    assert.ok(entries.get('word/document.xml').includes('w:val="ListParagraph"'));
    assert.ok(!entries.get('word/document.xml').includes('<w:numPr>'));
});
test('JSON rejects non-contract block fields instead of serializing private strings as offsets or kinds', async () => {
    const f = fixture();
    const badKind = { text: 'texto', blocks: [{ start: 0, end: 5, kind: 'ORIGINAL-SECRETO', runs: [] }] };
    const badOffset = { text: 'texto', blocks: [{ start: { original: 'ORIGINAL-SECRETO' }, end: 5, kind: 'paragraph', runs: [] }] };
    await assert.rejects(f.context.buildTextDocumentBlob(badKind, 'json'), /estructura/i);
    await assert.rejects(f.context.buildTextDocumentBlob(badOffset, 'json'), /estructura/i);
});
