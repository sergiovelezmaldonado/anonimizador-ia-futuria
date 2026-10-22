// Regresiones de restauración: el override solo sustituye restoreTags, no el motor.
// Sin FUTURIA_RESTORE_SNIPPET se prueba siempre el index.html real.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function cn(');
const end = html.indexOf('// ─── Texto de muestra', start);
assert.ok(start >= 0 && end > start, 'No se encontró el motor real en index.html');
const engine = html.slice(start, end);
const snippetPath = process.env.FUTURIA_RESTORE_SNIPPET;
const snippet = snippetPath ? readFileSync(path.resolve(snippetPath), 'utf8') : '';
if (snippetPath) assert.match(snippet, /^function restoreTags\(text, mapping\)/m);
console.log('Restauración bajo prueba:', snippetPath || 'index.html (sin override)');

function load() {
  const context = vm.createContext({ Intl });
  vm.runInContext(engine, context, { timeout: 2000, filename: 'index.html:engine' });
  if (snippetPath) vm.runInContext(snippet, context, { timeout: 2000, filename: snippetPath });
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
function restore(source, mapping, timeout = 1000) {
  const context = load();
  context.source = source;
  context.mapping = mapping;
  return plain(vm.runInContext('restoreTags(source, mapping)', context, { timeout }));
}
function apply(source, edits) {
  let cursor = 0;
  const parts = [];
  for (const edit of edits) {
    assert.ok(Number.isInteger(edit.start) && Number.isInteger(edit.end));
    assert.ok(edit.start >= cursor && edit.end > edit.start && edit.end <= source.length);
    assert.equal(typeof edit.replacement, 'string');
    parts.push(source.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

test('adversarial: 256000 espacios después de [A terminan dentro de vm timeout', () => {
  const source = '[A' + ' '.repeat(256000) + '!';
  const result = restore(source, {});
  assert.deepEqual(result, { out: source, resolved: [], unresolved: [], repaired: [], edits: [] });
});

const MAX_TEXT = 25 * 1024 * 1024; // Mismo presupuesto UTF-16 del modelo documental.
const MAX_EDITS = 250000;

test('expansión: 20000 etiquetas por 1400 caracteres fallan con error explícito', () => {
  const source = '[PERSONA_1]'.repeat(20000);
  const original = 'X'.repeat(1400);
  assert.throws(() => restore(source, { '[PERSONA_1]': original }), error => {
    assert.equal(error.code, 'RESTORE_TEXT_LIMIT');
    assert.match(error.message, /restauración.*límite.*UTF-16/i);
    return true;
  });
});

test('edits: la sustitución 250001 falla explícitamente, sin truncar el resultado', () => {
  const source = '[IP_1]'.repeat(MAX_EDITS + 1);
  assert.throws(() => restore(source, { '[IP_1]': '' }, 5000), error => {
    assert.equal(error.code, 'RESTORE_EDIT_LIMIT');
    assert.match(error.message, /restauración.*límite.*250000.*sustituciones/i);
    return true;
  });
});

// Las pruebas voluminosas devuelven solo resúmenes: no duplicar 25 Mi de texto
// ni 250000 edits al cruzar el VM no forma parte del contrato del motor.
function summarize(body, variables = {}, timeout = 5000) {
  const context = load();
  Object.assign(context, variables);
  return plain(vm.runInContext(`(() => { ${body} })()`, context, { timeout }));
}

test('adversarial: muchos corchetes anidados, incompletos y válidos no se atascan', () => {
  for (const source of [
    '['.repeat(256000) + '!',
    '[A'.repeat(128000) + '!',
    '[A '.repeat(64000) + '!',
    '[A' + ' '.repeat(256000) + '1' + ' '.repeat(256000) + '!',
    '[A' + '_-'.repeat(128000) + '!',
  ]) {
    const result = restore(source, {});
    assert.equal(result.out, source);
    assert.deepEqual(result.edits, []);
  }
  const source = '['.repeat(256000) + '[persona_1]' + ']'.repeat(256000);
  const result = restore(source, { '[PERSONA_1]': 'Ana' });
  assert.equal(result.out, '['.repeat(256000) + 'Ana' + ']'.repeat(256000));
  assert.deepEqual(result.edits, [{ start: 256000, end: 256011, replacement: 'Ana' }]);
});

test('contrato UTF-16: offsets exactos, valores literales, orden y reparación por aparición', () => {
  const source = '😀 e\u0301\r\n[person-001] / PERSONA_1 / [EMAIL_2] / [PERSONA_9] [PERSONA_9] [persona_8] [ANEXO_1] [anexo 1]';
  const mapping = { '[PERSONA_1]': 'Ana😀\r\n$& [EMAIL_2]', '[EMAIL_2]': 'a@b.test' };
  const result = restore(source, mapping);
  const candidates = ['[person-001]', 'PERSONA_1', '[EMAIL_2]'];
  const expectedEdits = candidates.map(found => ({
    start: source.indexOf(found), end: source.indexOf(found) + found.length,
    replacement: mapping[found === '[EMAIL_2]' ? '[EMAIL_2]' : '[PERSONA_1]'],
  }));
  assert.deepEqual(result.edits, expectedEdits);
  assert.equal(result.edits[0].start, 7, 'offset UTF-16, no número de puntos Unicode');
  assert.equal(result.out, apply(source, expectedEdits));
  assert.deepEqual(result.resolved, [
    { tag: '[PERSONA_1]', value: mapping['[PERSONA_1]'] },
    { tag: '[EMAIL_2]', value: mapping['[EMAIL_2]'] },
  ]);
  assert.deepEqual(result.unresolved, ['[PERSONA_9]', '[ANEXO_1]']);
  assert.deepEqual(result.repaired, [
    { found: '[person-001]', tag: '[PERSONA_1]' },
    { found: 'PERSONA_1', tag: '[PERSONA_1]' },
  ]);
  assert.deepEqual(mapping, { '[PERSONA_1]': 'Ana😀\r\n$& [EMAIL_2]', '[EMAIL_2]': 'a@b.test' });
});

test('contrato: espacios, guiones, ceros, tildes, alias y tipos arbitrarios entre corchetes', () => {
  const source = '[ \tTeLéFoNo - 0002\n] [tax-id--001] [ID_FISCAL_1] [DIRECCIÓN 4] [FOO_BAR - 3] foo_3 [PERSONA1]';
  const mapping = { '[TELEFONO_2]': 'tel', '[ID_FISCAL_1]': 'id', '[DIRECCION_4]': 'dir', '[FOO_BAR_3]': 'otro' };
  const result = restore(source, mapping);
  assert.equal(result.out, 'tel id id dir otro foo_3 [PERSONA1]');
  assert.equal(result.resolved.length, 4);
  assert.equal(result.repaired.length, 4);
  assert.equal(apply(source, result.edits), result.out);
});

test('contrato: límites Unicode de tokens sin corchetes y mapas no recursivos', () => {
  const source = 'foo_1 xPERSONA_1 PERSONA_1x _PERSONA_1 PERSONA_1_ ñPERSONA_1 PERSONA_1ñ 𐐀PERSONA_1 PERSONA_1𐐀 [PERSONA_1 PERSONA_1] (persona_1) 😀PERSONA_1😀';
  const result = restore(source, { '[PERSONA_1]': '[EMAIL_1]', '[EMAIL_1]': 'NO RECURSIVO' });
  assert.equal(result.out, 'foo_1 xPERSONA_1 PERSONA_1x _PERSONA_1 PERSONA_1_ ñPERSONA_1 PERSONA_1ñ 𐐀PERSONA_1 PERSONA_1𐐀 [PERSONA_1 PERSONA_1] ([EMAIL_1]) 😀[EMAIL_1]😀');
  assert.equal(result.edits.length, 2);
  assert.equal(apply(source, result.edits), result.out);
});

test('contrato: valores vacíos, nulos y primitivos conservan el valor y sustituyen como String', () => {
  const source = '[IP_1]|[IP_2]|[IP_3]|[IP_4]|[IP_5]|[IP_6]';
  const mapping = { '[IP_1]': '', '[IP_2]': 0, '[IP_3]': false, '[IP_4]': null, '[IP_5]': undefined };
  const result = restore(source, mapping);
  assert.equal(result.out, '|0|false|null|[IP_5]|[IP_6]');
  assert.deepEqual(result.resolved.map(item => item.value), ['', 0, false, null]);
  assert.deepEqual(result.unresolved, ['[IP_5]', '[IP_6]']);
  assert.equal(apply(source, result.edits), result.out);
  for (const source of [null, undefined, false, 0, '']) {
    assert.deepEqual(restore(source, {}), { out: '', resolved: [], unresolved: [], repaired: [], edits: [] });
  }
});

test('edits: admite exactamente 250000 sustituciones completas', () => {
  const result = summarize(`
    const source = '[IP_1]'.repeat(limit);
    const result = restoreTags(source, { '[IP_1]': '' });
    return { length: result.out.length, edits: result.edits.length,
      last: result.edits.at(-1), resolved: result.resolved, repaired: result.repaired.length };
  `, { limit: MAX_EDITS });
  assert.deepEqual(result, {
    length: 0, edits: MAX_EDITS,
    last: { start: (MAX_EDITS - 1) * 6, end: MAX_EDITS * 6, replacement: '' },
    resolved: [{ tag: '[IP_1]', value: '' }], repaired: 0,
  });
});

test('tamaño: admite exactamente 25 Mi UTF-16 y rechaza una unidad más antes del ensamblado', () => {
  assert.deepEqual(summarize(`
    const result = restoreTags('[IP_1]', { '[IP_1]': '😀'.repeat(limit / 2) });
    return { length: result.out.length, edits: result.edits.length, tail: result.out.slice(-2) };
  `, { limit: MAX_TEXT }), { length: MAX_TEXT, edits: 1, tail: '😀' });
  assert.throws(() => summarize(`
    return restoreTags('[IP_1]', { '[IP_1]': '😀'.repeat(limit / 2) + 'X' });
  `, { limit: MAX_TEXT }), error => error.code === 'RESTORE_TEXT_LIMIT');
  assert.throws(() => summarize(`
    return restoreTags('X'.repeat(limit + 1), {});
  `, { limit: MAX_TEXT }), error => error.code === 'RESTORE_TEXT_LIMIT');
});

test('tamaño: cuenta el texto intacto final, pero no rechaza contracciones posteriores válidas', () => {
  assert.throws(() => summarize(`
    return restoreTags('[IP_1]' + 'X'.repeat(limit), { '[IP_1]': 'Z' });
  `, { limit: MAX_TEXT }), error => error.code === 'RESTORE_TEXT_LIMIT');
  const result = summarize(`
    const source = '[IP_1][PERSONA_1]' + 'X'.repeat(limit - 17);
    const result = restoreTags(source, { '[IP_1]': 'Z'.repeat(16), '[PERSONA_1]': '' });
    return { length: result.out.length, edits: result.edits.length, head: result.out.slice(0, 17) };
  `, { limit: MAX_TEXT });
  assert.deepEqual(result, { length: MAX_TEXT - 1, edits: 2, head: 'Z'.repeat(16) + 'X' });
});

test('expansión: detiene la lectura del mapa en el primer prefijo que excede el presupuesto', () => {
  const result = summarize(`
    let reads = 0;
    const mapping = Object.create(null);
    Object.defineProperty(mapping, '[IP_1]', { get() { reads++; return 'X'.repeat(1400); } });
    try { restoreTags('[IP_1]'.repeat(20000), mapping); }
    catch (error) { return { code: error.code, reads }; }
    return { code: 'NO_ERROR', reads };
  `);
  assert.deepEqual(result, { code: 'RESTORE_TEXT_LIMIT', reads: Math.floor(MAX_TEXT / 1400) + 1 });
});

test('documento normal de 200 páginas: sin límites pequeños ni pérdida de caracteres o edits', () => {
  const page = 'Página😀\r\n' + 'Texto de contrato. '.repeat(160) + '\r\nCliente [PERSONA_1]. Contacto EMAIL_1.\n\f';
  const source = page.repeat(200);
  const mapping = { '[PERSONA_1]': 'Ana Ruiz', '[EMAIL_1]': 'ana@ejemplo.test' };
  const result = restore(source, mapping, 2000);
  assert.equal(result.out, page.replace('[PERSONA_1]', mapping['[PERSONA_1]']).replace('EMAIL_1', mapping['[EMAIL_1]']).repeat(200));
  assert.equal(result.edits.length, 400);
  assert.equal(result.resolved.length, 2);
  assert.equal(result.repaired.length, 200);
  assert.deepEqual(result.unresolved, []);
  assert.equal(apply(source, result.edits), result.out);
});

// Oráculo histórico SOLO para muestras pequeñas: no usar este patrón en producción.
// Congela todos los campos del contrato mientras cambia el mecanismo de búsqueda.
function legacyRestore(source, mapping, aliases, canonical) {
  assert.ok(source.length < 512, 'El oráculo vulnerable no admite entradas largas');
  const resolved = [], unresolved = new Set(), repaired = [], edits = [], seen = new Set();
  const kinds = [...new Set([...Object.keys(aliases), ...Object.values(aliases), 'PERSONA', 'EMAIL', 'URL', 'IP', 'CREDENCIAL', 'CUENTA', 'ID_FISCAL', 'TELEFONO', 'MONTO', 'NACIMIENTO', 'DIRECCION', 'EMPRESA', 'FECHA', 'PERSONALIZADO'])].sort((a, b) => b.length - a.length).join('|');
  const pattern = new RegExp('\\[\\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ_\\s\\-]*?)[\\s_\\-]+(\\d+)\\s*\\]|(?<![\\p{L}\\p{N}_\\[])(' + kinds + ')_(\\d+)(?![\\p{L}\\p{N}_\\]])', 'giu');
  const out = source.replace(pattern, (whole, kindA, numA, kindB, numB, offset) => {
    const tag = canonical((kindA ?? kindB).trim(), numA ?? numB);
    if (mapping[tag] === undefined) {
      if (/^\[[A-Z_]+_\d+\]$/.test(whole)) unresolved.add(whole);
      return whole;
    }
    if (!seen.has(tag)) { seen.add(tag); resolved.push({ tag, value: mapping[tag] }); }
    if (whole !== tag) repaired.push({ found: whole, tag });
    edits.push({ start: offset, end: offset + whole.length, replacement: String(mapping[tag]) });
    return mapping[tag];
  });
  return { out, resolved, unresolved: [...unresolved], repaired, edits };
}

test('compatibilidad diferencial: todos los alias y 5000 muestras acotadas de la gramática anterior', () => {
  const context = load();
  const aliases = plain(vm.runInContext('TAG_ALIASES', context));
  const canonical = vm.runInContext('canonicalTag', context);
  const mapping = { '[PERSONA_1]': 'Ana😀', '[EMAIL_1]': 'a@b.test', '[A_1]': 'a', '[A_B_1]': 'ab', '[FOO_1]': 'f', '[S_1]': 's', '[K_1]': 'k' };
  const kinds = [...new Set([...Object.keys(aliases), ...Object.values(aliases), 'URL', 'IP', 'FOO', 'A_B', 'ſ', 'K'])];
  const samples = [];
  for (const kind of kinds) {
    mapping[canonical(kind, '1')] = 'valor:' + kind;
    for (const separator of ['_', ' ', '-', '__', ' -_ ', '\t', '\n', '\u00a0']) {
      for (const num of ['1', '0001']) {
        samples.push('😀[ \t' + kind.toLowerCase() + separator + num + '\n] ' + kind + '_' + num + '!');
      }
    }
  }
  const atoms = ['[', ']', ' ', 'A', 'B', 'PERSONA', 'email', '_', '-', '1', '01', 'x', '!', '\n', '\t', '\u00a0', 'ſ', 'K', 'é', '😀', '𐐀'];
  let seed = 0x7a91c3;
  for (let i = 0; i < 5000; i++) {
    let source = '';
    for (let j = 0; j < 10; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      source += atoms[seed % atoms.length];
    }
    samples.push(source);
  }
  samples.push('[PERSONA1] PERSONA_1', '[foo1 PERSONA_1 ]', '[foo1 PERSONA_1]', '[A_B___0001]', '[PERSONA_0001] [PERSONA_0]', '[PERSONA_' + '9'.repeat(320) + ']');
  context.samples = samples;
  context.mapping = mapping;
  const actual = plain(vm.runInContext('samples.map(source => restoreTags(source, mapping))', context, { timeout: 5000 }));
  assert.equal(actual.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    assert.deepEqual(actual[i], legacyRestore(samples[i], mapping, aliases, canonical), JSON.stringify(samples[i]));
    assert.equal(apply(samples[i], actual[i].edits), actual[i].out);
  }
});
