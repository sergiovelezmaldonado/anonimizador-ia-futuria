// Fase 0 — motor. Pruebas escritas ANTES de implementar (RED → GREEN).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const engine = html.slice(html.indexOf('function cn('), html.indexOf('// ─── Texto de muestra'));
const ctx = vm.createContext({ Intl });
vm.runInContext(engine + '\nthis.engine = { CATS, runAnonymize, computeResidualRisk, getRiskInfo, restoreTags, VALIDATORS, normalizeEntity };', ctx);
const { runAnonymize, computeResidualRisk: residualRaw, restoreTags: restoreRaw, VALIDATORS, CATS, normalizeEntity } = ctx.engine;
// Los valores cruzan el límite del VM: se clonan para que deepEqual compare estructura, no realm.
const clone = v => JSON.parse(JSON.stringify(v));
const computeResidualRisk = (...a) => clone(residualRaw(...a));
const restoreTags = (...a) => clone(restoreRaw(...a));
const on = CATS.filter(c => c.on);
const all = CATS;
const byId = id => CATS.find(c => c.id === id);
const r = (text, cats = on, terms = '', opts) => runAnonymize(text, cats, terms, opts);
const tagsOf = (res, catId) => res.reps.filter(x => x.catId === catId);
const hidden = (res, ...values) => values.forEach(v => assert.ok(!res.out.includes(v), 'quedó en claro: ' + v + ' → ' + res.out));
const visible = (res, ...values) => values.forEach(v => assert.ok(res.out.includes(v), 'se sustituyó indebidamente: ' + v + ' → ' + res.out));

// ── 1. Semáforo por categorías activas ─────────────────────────────────────────
test('el semáforo solo bloquea por categorías activas; las inactivas avisan', () => {
  const text = 'Monto $85.340 con vencimiento 15/03/2026 en Av. República #123';
  const activeIds = on.map(c => c.id); // money, address, date están apagadas por defecto
  const risk = computeResidualRisk(text, activeIds);
  assert.equal(risk.hits.length, 0, 'no debe bloquear: ' + risk.hits);
  assert.ok(risk.warnings.length >= 3, 'debe avisar de las inactivas: ' + risk.warnings);
  const sinFiltro = computeResidualRisk(text);
  assert.ok(sinFiltro.hits.length >= 3, 'sin lista de activas se conserva el comportamiento anterior');
});
test('con la categoría activa, un dato pendiente sí bloquea', () => {
  const risk = computeResidualRisk('correo juan@ejemplo.test', ['email']);
  assert.deepEqual(risk.hits, [byId('email').label]);
});

// ── 2. Misma entidad, misma etiqueta ───────────────────────────────────────────
test('la misma persona recibe la misma etiqueta en todas sus apariciones', () => {
  const res = r('Paciente: María García. La Sra. María García llamó. Contacto: MARIA GARCIA.');
  const tags = new Set(tagsOf(res, 'person').map(x => x.replacement));
  assert.equal(tags.size, 1, [...tags].join());
  assert.equal(res.reps.filter(x => x.catId === 'person').length, 1, 'el mapa lista cada entidad una sola vez');
  hidden(res, 'García', 'GARCIA');
});
test('el mismo correo en dos lugares recibe la misma etiqueta y distintos correos etiquetas distintas', () => {
  const res = r('a@x.test, b@x.test y de nuevo a@x.test');
  const emails = tagsOf(res, 'email');
  assert.equal(emails.length, 2);
  assert.equal((res.out.match(/\[EMAIL_1\]/g) || []).length, 2);
});
test('normalizeEntity ignora acentos, mayúsculas y espacios repetidos', () => {
  assert.equal(normalizeEntity('María  García'), normalizeEntity('maria garcia'));
});

// ── 3. Nombres en MAYÚSCULAS y contextos de empresa / inglés ───────────────────
test('detecta nombres en MAYÚSCULAS tras contexto de contrato', () => {
  const res = r('REPRESENTANTE: JORGE ENRIQUE PEDRAZA SILVA, mayor de edad. CONTRATISTA: ANA DE LA TORRE.');
  hidden(res, 'JORGE ENRIQUE PEDRAZA SILVA', 'ANA DE LA TORRE');
  visible(res, 'mayor de edad');
});
test('contextos de empresa: Proveedor, Cliente, Apoderado, Contratante, Atte., identificado con, Yo,', () => {
  const res = r('Proveedor: Luis Paredes. Apoderado: Marta Ruiz Díaz. Yo, Pedro Salinas, declaro. Atte. Carla Mena');
  hidden(res, 'Luis Paredes', 'Marta Ruiz Díaz', 'Pedro Salinas', 'Carla Mena');
});
test('contextos en inglés: Dear, Mr., Ms., Attn, Buyer, Seller, Regards', () => {
  const res = r('Dear Mr. John Smith, Attn: Mary Johnson. Buyer: Robert Brown. Best regards, Alice Cooper');
  hidden(res, 'John Smith', 'Mary Johnson', 'Robert Brown', 'Alice Cooper');
});
test('cargos y entidades en mayúsculas no se tratan como personas', () => {
  const res = r('CONTRATANTE: BANCO DEL PACÍFICO S.A. Cargo: GERENTE GENERAL');
  assert.equal(tagsOf(res, 'person').length, 0, JSON.stringify(res.reps));
});

// ── 4. Identificadores por país sin prefijo, con dígito verificador ────────────
const idCases = [
  ['EC cédula válida', '1710034065', true], ['EC cédula inválida', '1710034066', false],
  ['EC RUC', '1710034065001', true],
  ['CL RUT con puntos', '12.345.678-5', true], ['CL RUT sin puntos', '12345678-5', true], ['CL RUT inválido', '12.345.678-9', false],
  ['AR CUIT con guiones', '20-12345678-6', true], ['AR CUIT sin guiones', '20123456786', true], ['AR CUIT inválido', '20-12345678-9', false],
  ['CO NIT', '900.123.456-8', true], ['CO NIT sin puntos', '9001234568', true], ['CO NIT inválido', '900.123.456-1', false],
  ['MX CURP válida', 'GODE561231HDFNRN05', true], ['MX CURP minúsculas', 'gode561231hdfnrn05', false], ['MX CURP verificador malo', 'GODE561231HDFNRN09', false],
  ['MX RFC fecha válida', 'GODE561231GR8', true], ['MX RFC fecha inválida', 'GODE561331GR8', false],
  ['MX CLABE', '002010077777777771', true],
  ['PE RUC', '20100070970', true], ['PE RUC inválido', '20100070971', false],
  ['UY CI', '1.234.567-2', true], ['UY CI inválida', '1.234.567-3', false],
  ['SV DUI', '04210000-8', true],
  ['DO cédula', '001-1234567-8', null],
  ['AR CBU', '0170099220000067797370', true],
];
test('VALIDATORS expone verificadores por país', () => {
  const keyOf = { EC: 'EC_CEDULA', CL: 'CL_RUT', AR: 'AR_CUIT', CO: 'CO_NIT', MX: 'MX_CURP', PE: 'PE_RUC', UY: 'UY_CI', SV: 'SV_DUI' };
  for (const [name, value, expected] of idCases) {
    if (expected === null) continue;
    const cc = name.split(' ')[0], kind = name.split(' ')[1].toUpperCase();
    let key = keyOf[cc];
    if (cc === 'EC' && kind === 'RUC') key = 'EC_RUC';
    if (cc === 'MX' && kind === 'RFC') key = 'MX_RFC';
    if (cc === 'MX' && kind === 'CLABE') key = 'MX_CLABE';
    if (cc === 'AR' && kind === 'CBU') key = 'AR_CBU';
    const fn = VALIDATORS[key];
    assert.equal(typeof fn, 'function', 'falta validador ' + key);
    assert.equal(fn(value), expected, name + ' ' + value);
  }
});
test('identificadores válidos de cada país se sustituyen sin palabra clave', () => {
  for (const [name, value, expected] of idCases) {
    if (expected === false) continue;
    const res = r('Identificación ' + value + ' registrada.');
    hidden(res, value);
    assert.ok(tagsOf(res, 'fiscal').length || tagsOf(res, 'financial').length, name + ' sin categoría: ' + JSON.stringify(res.reps));
  }
});
test('los formatos con puntuación nacional se detectan aunque no haya verificador', () => {
  for (const v of ['8-123-4567', 'PE-12-345', 'E-8-12345', '1-1234-5678', '3-101-123456', '0801-1990-12345', '001-010190-0001A',
    '1234 56789 0101', '12.345.678', 'V-12.345.678', 'J-30123456-7', '0614-123456-123-4', '001-1234567-8']) {
    hidden(r('Documento ' + v + ' adjunto.'), v);
  }
});
test('números sin verificador ni formato necesitan contexto; un pedido de 8 dígitos no se toca', () => {
  visible(r('Pedido 45678912 entregado.'), '45678912');
  hidden(r('DNI 45678912'), '45678912');
  hidden(r('identificado con 45678912'), '45678912');
  hidden(r('Cédula de identidad 4567891 LP'), '4567891 LP');
  hidden(r('Pasaporte AB123456'), 'AB123456');
});
test('un identificador con verificador válido tiene prioridad al reportarse como válido', () => {
  const res = r('RUT 12.345.678-5');
  assert.equal(tagsOf(res, 'fiscal')[0].valid, true);
});

// ── 5. Teléfonos locales y monedas de la región ────────────────────────────────
test('teléfonos locales por país se detectan con o sin contexto', () => {
  const phones = ['0991234567', '099 123 4567', '310 456 7890', '3104567890', '55 1234 5678', '9 1234 5678', '11 4567-8901', '987 654 321', '(02) 2345-678', '2234-5678'];
  for (const p of phones) hidden(r('Tel: ' + p + ' disponible.'), p);
  for (const p of ['0991234567', '310 456 7890', '55 1234 5678', '11 4567-8901']) hidden(r('Llamar al ' + p + ' hoy.'), p);
});
test('WhatsApp y Cel. cuentan como contexto telefónico', () => {
  hidden(r('WhatsApp +593 99 123 4567 o Cel. 0987654321'), '99 123 4567', '0987654321');
});
test('montos en todas las monedas hispanoamericanas', () => {
  const money = byId('money');
  const amounts = ['$85.340', 'US$ 1,200', 'USD 45,000.00', 'MXN 12,500', 'COP 4.200.000', 'S/ 3,500.50', 'Bs. 12.000', 'Gs. 1.500.000', 'Q 2,500', 'L 1,200.00', '₡ 45.000', 'RD$ 25,000', 'B/. 1,250.00', 'C$ 3,400', '€ 12.500,00', 'UF 1.250', 'CLP 450.000', 'ARS 150.000', 'PEN 2,300', '4.200.000 COP', '1,500 USD', '2.500 pesos', '3.400 dólares', '1.200 soles'];
  for (const a of amounts) {
    const res = r('Total ' + a + ' pagado.', [money]);
    hidden(res, a.replace(/^\s+/, ''));
  }
});
test('un número sin moneda no es monto', () => {
  visible(r('Lote 4.200.000 unidades', [byId('money')]), '4.200.000');
});

// ── 6. Fechas largas, ISO y fecha de nacimiento ────────────────────────────────
test('fechas largas e ISO con la categoría Fechas', () => {
  const date = byId('date');
  for (const d of ['15 de marzo de 1985', '15 marzo 1985', '1985-03-15', '15-mar-1985', '15/03/85']) hidden(r('El ' + d + ' firmó.', [date]), d);
});
test('fecha de nacimiento y edad son categoría propia, activa por defecto', () => {
  const birth = byId('birthdate');
  assert.ok(birth && birth.on, 'falta categoría birthdate activa');
  const res = r('Fecha de nacimiento: 7 de septiembre de 1985. Edad: 38 años. Nació el 12/05/1990. 45 años de edad.');
  hidden(res, '7 de septiembre de 1985', '38', '12/05/1990', '45 años');
  assert.ok(tagsOf(res, 'birthdate').length >= 3);
});

// ── 7. Validadores genéricos ───────────────────────────────────────────────────
test('Luhn e IBAN mod-97 marcan validez en la tabla', () => {
  const res = r('Tarjeta 4539 1488 0343 6467 y 4111 1111 1111 1112; IBAN ES91 2100 0418 4502 0005 1332');
  const fin = tagsOf(res, 'financial');
  assert.equal(fin.find(x => x.original.startsWith('4539')).valid, true);
  assert.equal(fin.find(x => x.original.startsWith('4111')).valid, false);
  assert.equal(fin.find(x => x.original.startsWith('ES91')).valid, true);
});

// ── 8. Recuperación tolerante ──────────────────────────────────────────────────
test('restoreTags repara etiquetas deformadas por el LLM', () => {
  const mapping = { '[PERSONA_1]': 'Ana Ruiz', '[EMAIL_1]': 'ana@x.test', '[TELEFONO_2]': '0991234567', '[ID_FISCAL_1]': '1710034065' };
  const text = 'Hola [PERSONA 1], escribe a **[EMAIL_1]** o [persona_1]; tel [TELEFONO_2 ] y PERSONA_1. ID: [TAX_ID_1]. Also [PERSON_1] and [PHONE_2]. Falta [PERSONA_9].';
  const res = restoreTags(text, mapping);
  assert.ok(!/PERSONA|EMAIL_1|TELEFONO|PERSON_1|PHONE_2|TAX_ID/.test(res.out.replace('[PERSONA_9]', '')), res.out);
  assert.ok(res.out.includes('Hola Ana Ruiz'));
  assert.ok(res.out.includes('**ana@x.test**'));
  assert.ok(res.out.includes('0991234567'));
  assert.ok(res.out.includes('1710034065'));
  assert.deepEqual(res.unresolved, ['[PERSONA_9]']);
  assert.ok(res.repaired.length >= 5, 'repaired: ' + JSON.stringify(res.repaired));
  assert.equal(res.resolved.length, 4);
});
test('restoreTags no toca texto que parece etiqueta pero no está en el mapa ni rompe corchetes normales', () => {
  const res = restoreTags('Ver [anexo 1] y [PERSONA_1].', { '[PERSONA_1]': 'Ana' });
  assert.equal(res.out, 'Ver [anexo 1] y Ana.');
  assert.deepEqual(res.unresolved, []);
});

// ── 9. Lista blanca y preset «identidad sí, cifras no» ─────────────────────────
test('la lista blanca impide sustituir términos propios aunque coincidan con patrones', () => {
  const res = r('Contacto de Acme S.A.: ventas@acme.test, Quito. Cliente: Juan Pérez', [...on, byId('company')], 'Quito', { whitelist: 'Acme S.A.\nventas@acme.test\nQuito' });
  visible(res, 'Acme S.A.', 'ventas@acme.test', 'Quito');
  hidden(res, 'Juan Pérez');
  const risk = computeResidualRisk(res.out, [...on, byId('company')].map(c => c.id), { whitelist: 'Acme S.A.\nventas@acme.test\nQuito' });
  assert.equal(risk.hits.length, 0, risk.hits.join());
});
test('nombre antes del identificador («Nombre, C.C. 123») y C.C. con puntos siguen cubiertos', () => {
  const res = r('Roberto Hernández Figueroa, C.C. 10.234.567, y ANA LUCÍA RUIZ, DNI 12.345.678, firman. Renovación: $48.000.000/año; lote 4.200.000 unidades.');
  hidden(res, 'Roberto Hernández Figueroa', '10.234.567', 'ANA LUCÍA RUIZ', '12.345.678');
  visible(res, '48.000.000', '4.200.000');
  assert.equal(tagsOf(res, 'person').length, 2);
});
test('reps incluye valid=null cuando no hay verificador y count de apariciones', () => {
  const res = r('a@x.test y a@x.test');
  assert.equal(res.reps[0].count, 2);
  assert.equal(res.reps[0].valid, null);
});
