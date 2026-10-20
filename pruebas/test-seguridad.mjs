import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const engine = html.slice(html.indexOf('function cn('), html.indexOf('// ─── Texto de muestra'));
const ctx = vm.createContext({ Intl });
vm.runInContext(engine + '\nthis.engine = { CATS, runAnonymize, computeResidualRisk, getRiskInfo };', ctx);
const { getRiskInfo, computeResidualRisk, runAnonymize, CATS } = ctx.engine;
test('sustituye nombres contextuales y sus repeticiones sin tratar Gerente General como persona', () => {
  const text = 'Representada por Andrea Morales Jiménez, Gerente General.\nTRABAJADOR: Carlos Alberto Mendoza Restrepo, C.C. 1.032.456.789.\nFirma empleador: Andrea Morales Jiménez';
  const result = runAnonymize(text, CATS.filter(c => c.on), '');
  assert.ok(!result.out.includes('Andrea Morales Jiménez'));
  assert.ok(!result.out.includes('Carlos Alberto Mendoza Restrepo'));
  assert.ok(result.out.includes('Gerente General'));
  assert.ok(result.reps.some(r => r.catId === 'person'));
});
test('la revisión residual cubre tarjetas, SSN, CURP y URL, no solo seis formatos parciales', () => {
  for (const text of ['4539 1488 0343 6467', '123-45-6789', 'GODE561231HDFNRN09', 'https://intranet.ejemplo.test/clientes']) {
    assert.ok(computeResidualRisk(text).hits.length > 0, 'residual no reconocido: ' + text);
  }
});
test('los términos personalizados no corrompen etiquetas y gana el término más largo', () => {
  const result = runAnonymize('Ana María Pérez usa ana@ejemplo.test. [EMAIL_1]', CATS.filter(c => c.on), 'Ana\nAna María Pérez\nemail');
  assert.ok(!result.out.includes('María Pérez'));
  assert.ok(result.out.endsWith('[EMAIL_1]'));
  assert.ok(result.reps.some(r => r.original === 'Ana María Pérez'));
  assert.ok(result.reps.some(r => r.original === 'ana@ejemplo.test' && r.replacement !== '[EMAIL_1]'));
  assert.ok(result.reps.every(r => !r.original.includes('[EMAIL_')));
});
test('no omite credenciales cortas ni cuentas y cédulas rotuladas', () => {
  for (const text of ['password=abc', 'api_key=x', 'C.C. 52.891.234', 'Cuenta corriente No. 456-789012-34']) {
    const result = runAnonymize(text, CATS.filter(c => c.on), '');
    assert.notEqual(result.out, text, text);
    assert.equal(computeResidualRisk(result.out).hits.length, 0, result.out);
  }
});
test('credenciales entre comillas conservan coma y punto y coma dentro de la sustitución', () => {
  for (const text of ['password="DEMO,SUFIJO;FINAL"', 'password=DEMO,SUFIJO;FINAL', 'password DEMOabcdef', 'api_key "a b,c;d\\\"e\\\\f"', "contraseña: 'a b,c;d\\'e'", 'password="primera\nsegunda"']) {
    const result = runAnonymize(text, CATS.filter(c => c.on), '');
    assert.match(result.out, /^\[CREDENCIAL_\d+\]$/);
    assert.equal(result.reps[0].original, text);
  }
});
test('términos explícitos solapados se cubren completos, incluso con una URL dentro', () => {
  for (const [text, terms] of [
    ['Proyecto Reservado https://interna.ejemplo.test/cliente', 'Proyecto Reservado https://interna.ejemplo.test/cliente'],
    ['Ana María Pérez García', 'Ana María Pérez\nMaría Pérez García'],
  ]) {
    const result = runAnonymize(text, CATS.filter(c => c.on), terms);
    assert.match(result.out, /^\[PERSONALIZADO_\d+\]$/);
    assert.equal(result.reps[0].original, text);
  }
});
test('unión de intervalos es reversible y protege etiquetas existentes sin filtrar los extremos', () => {
  const text = 'Ana María Pérez García usa ana@ejemplo.test. Nombre [EMAIL_1] Apellido';
  const result = runAnonymize(text, CATS.filter(c => c.on), 'Ana María Pérez\nMaría Pérez García\nAna\nNombre [EMAIL_1] Apellido');
  assert.ok(!result.out.includes('García'));
  assert.ok(!result.out.includes('Nombre'));
  assert.ok(!result.out.includes('Apellido'));
  assert.ok(result.out.includes('[EMAIL_1]'));
  assert.ok(result.reps.some(r => r.original === 'ana@ejemplo.test'));
  assert.ok(result.reps.every(r => !r.original.includes('[EMAIL_1]')));
  const map = Object.fromEntries(result.reps.map(r => [r.replacement, r.original]));
  assert.equal(result.out.replace(/\[[A-Z_]+_\d+\]/g, tag => map[tag] ?? tag), text);
});
test('mapas nuevos preservan tabulaciones y saltos; mapas clásicos siguen admitidos', () => {
  assert.equal(typeof ctx.serializeEquivalences, 'function');
  assert.equal(typeof ctx.parseEquivalences, 'function');
  for (const original of ['María\tGarcía\nLópez', '  Ana \r\nPérez\t ', '"literal" \\n \\t', '']) {
    const reps = [{replacement:'[PERSONA_1]',original,catLabel:'Persona',hint:null}];
    assert.match(ctx.serializeEquivalences(reps), /Original \(JSON\)/);
    const map = ctx.parseEquivalences(ctx.serializeEquivalences(reps));
    assert.equal(map['[PERSONA_1]'], original);
  }
  assert.equal(ctx.parseEquivalences('Etiqueta\tOriginal\n[EMAIL_1]\tmaria@ejemplo.test')['[EMAIL_1]'], 'maria@ejemplo.test');
  assert.equal(ctx.parseEquivalences('Etiqueta\tOriginal\n[PERSONA_1]\t"nombre\\nclásico"')['[PERSONA_1]'], '"nombre\\nclásico"');
});
test('mapas JSON inválidos se rechazan con un mensaje de formato claro', () => {
  assert.equal(typeof ctx.parseEquivalences, 'function');
  for (const original of ['sin comillas', '123', 'null', '"cadena sin cierre']) {
    assert.throws(() => ctx.parseEquivalences('Etiqueta\tOriginal (JSON)\n[PERSONA_1]\t' + original), /formato.*JSON|JSON.*inv[aá]lido/i);
  }
});
test('credenciales con separadores multilínea se sustituyen completas sin consumir solo el signo', () => {
  for (const text of ['password =\n"DEMOabcdef"', 'api_key:\r\n  DEMOabcdefgh', 'password\n = \nDEMOabcdef']) {
    const result = runAnonymize(text, CATS.filter(c => c.on), '');
    assert.match(result.out, /^\[CREDENCIAL_\d+\]$/);
    assert.equal(result.reps[0].original, text);
  }
});
test('un mismo término con ocurrencias solapadas cubre la unión y se recupera exacto', () => {
  for (const [text, term] of [['Ana Ana Ana', 'Ana Ana'], ['ABCABCABC', 'ABCABC']]) {
    const result = runAnonymize(text, CATS.filter(c => c.on), term);
    assert.match(result.out, /^\[PERSONALIZADO_\d+\]$/);
    assert.equal(result.reps[0].original, text);
    const map=Object.fromEntries(result.reps.map(r=>[r.replacement,r.original]));
    assert.equal(result.out.replace(/\[[A-Z_]+_\d+\]/g, tag=>map[tag]??tag), text);
  }
});
test('cero coincidencias nunca significa Listo para usar ni riesgo garantizado', () => {
  assert.equal(getRiskInfo(0).emoji, '🟡');
  assert.match(getRiskInfo(0).label, /revisi[oó]n|revisar/i);
  assert.doesNotMatch(getRiskInfo(0).label, /listo|seguro/i);
});
