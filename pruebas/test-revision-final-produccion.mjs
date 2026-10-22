// Regresiones de los hallazgos de la revisión independiente del 2026-10-22:
// resaltado que bloquea el hilo, carga de restauración sin guarda de generación
// e inventario de dependencias embebidas en bundles preempaquetados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const slice = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));

function engine() {
  const context = vm.createContext({ console, TextEncoder, TextDecoder });
  vm.runInContext(slice('function cn(', '// ─── Texto de muestra') + '\n'
    + slice('// ─── Modelo de documentos textuales', '// ─── Fin modelo de documentos textuales'), context);
  return context;
}

// Los objetos creados dentro del contexto VM no son reference-equal con los de
// este realm: se comparan sus datos, no sus prototipos.
const plain = value => JSON.parse(JSON.stringify(value));

// ─── Resaltado del texto restaurado ───────────────────────────────────────────

test('el resaltado se construye desde los intervalos, sin un patrón con todos los valores', () => {
  const context = engine();
  assert.equal(typeof context.buildRestoredSegments, 'function',
    'falta buildRestoredSegments: el resaltado todavía depende de un regex de alternancia');
  // El ancla de cierre debe existir: con un ancla muerta indexOf da -1 y la
  // región se convertiría en el resto del archivo, volviendo la prueba vacua.
  const inicio = html.indexOf('const highlighted = useMemo(');
  const fin = html.indexOf('\n  return (', inicio);
  assert.ok(inicio > 0 && fin > inicio, 'no se delimitó la región del resaltado');
  const region = html.slice(inicio, fin);
  assert.doesNotMatch(region, /new RegExp/, 'el resaltado no debe compilar un patrón con los valores restaurados');
  assert.match(region, /buildRestoredSegments/);
});

test('los segmentos reconstruyen el texto y marcan solo lo restaurado', () => {
  // Los intervalos se toman del motor real: vienen en coordenadas del texto de
  // entrada, con etiquetas más cortas o más largas que el valor restaurado.
  const { buildRestoredSegments, restoreTags } = engine();
  const recovered = restoreTags(
    'Hola [PERSONA_1], escribe a [EMAIL_1] o a [PERSONA_1].',
    { '[PERSONA_1]': 'Ana Ruiz', '[EMAIL_1]': 'ana@ejemplo.test' }
  );
  const out = recovered.out;
  assert.equal(out, 'Hola Ana Ruiz, escribe a ana@ejemplo.test o a Ana Ruiz.');
  const { segments, shown, total, truncated } = buildRestoredSegments(out, recovered.edits);
  assert.equal(segments.map(s => s.text).join(''), out, 'los segmentos deben reconstruir el texto exacto');
  assert.deepEqual(plain(segments.filter(s => s.restored).map(s => s.text)), ['Ana Ruiz', 'ana@ejemplo.test', 'Ana Ruiz']);
  assert.equal(shown, 3);
  assert.equal(total, 3);
  assert.equal(truncated, false);
});

test('un valor que reaparece por su cuenta no se marca como restaurado', () => {
  const { buildRestoredSegments, restoreTags } = engine();
  // El segundo "Ana" lo escribió la IA: no proviene de una sustitución.
  const recovered = restoreTags('[PERSONA_1] y Ana', { '[PERSONA_1]': 'Ana' });
  assert.equal(recovered.out, 'Ana y Ana');
  const { segments } = buildRestoredSegments(recovered.out, recovered.edits);
  assert.deepEqual(plain(segments.map(s => [s.text, s.restored])), [['Ana', true], [' y Ana', false]]);
});

test('el resaltado se acota y avisa cuando hay demasiadas sustituciones', () => {
  const { buildRestoredSegments } = engine();
  const valor = 'Nombre Apellido';
  const out = Array(5000).fill(valor).join(' ');
  const edits = [];
  for (let i = 0; i < 5000; i++) edits.push({ start: i * (valor.length + 1), end: i * (valor.length + 1) + valor.length, replacement: valor });
  const { segments, shown, total, truncated } = buildRestoredSegments(out, edits, 1000);
  assert.equal(total, 5000);
  assert.equal(shown, 1000);
  assert.equal(truncated, true);
  assert.equal(segments.map(s => s.text).join(''), out, 'incluso acotado debe conservar todo el texto');
  assert.equal(segments.filter(s => s.restored).length, 1000);
});

test('el resaltado de un documento grande no bloquea el hilo', () => {
  const context = engine();
  const valor = 'D'.repeat(60);
  const partes = [];
  const edits = [];
  let cursor = 0;
  for (let i = 0; i < 100000; i++) {
    partes.push(valor, ' ');
    edits.push({ start: cursor, end: cursor + valor.length, replacement: valor });
    cursor += valor.length + 1;
  }
  const out = partes.join('');
  context.__out = out;
  context.__edits = edits;
  const started = Date.now();
  // Un temporizador no interrumpe el hilo: el límite se comprueba midiendo.
  const result = vm.runInContext('buildRestoredSegments(__out, __edits)', context, { timeout: 4000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, 'el resaltado tardó ' + elapsed + ' ms con 100.000 sustituciones');
  assert.equal(result.total, 100000);
  assert.ok(result.truncated, 'debe acotar los nodos pintados');
  assert.ok(result.segments.length < 6000, 'demasiados nodos para pintar: ' + result.segments.length);
});

// ─── Carga del documento a restaurar ──────────────────────────────────────────

function recoverFixture(initial = []) {
  const slots = [...initial];
  const effects = [];
  const cleanup = [];
  const alerts = [];
  let cursor = 0;
  const hooks = {
    useState(v) { const i = cursor++; if (!(i in slots)) slots[i] = v; return [slots[i], n => { slots[i] = typeof n === 'function' ? n(slots[i]) : n; }]; },
    useRef(v) { const i = cursor++; return slots[i] ??= { current: v }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((d, j) => !Object.is(d, slots[i][j]))) { slots[i] = deps; effects.push(() => { cleanup[i]?.(); cleanup[i] = fn(); }); } },
    dialogs: { alert: (message, title) => alerts.push({ message, title }), confirm: async () => true },
  };
  const context = vm.createContext({
    React: hooks, useState: hooks.useState.bind(hooks), useRef: hooks.useRef.bind(hooks),
    useMemo: hooks.useMemo.bind(hooks), useEffect: hooks.useEffect.bind(hooks), useDialog: () => hooks.dialogs,
    TextEncoder, TextDecoder, console, setTimeout() {}, window: { addEventListener() {}, removeEventListener() {} },
  });
  vm.runInContext(slice('function cn(', '// ─── Texto de muestra') + '\n'
    + slice('// ─── Modelo de documentos textuales', '// ─── Fin modelo de documentos textuales'), context);
  const source = slice('function RecoverTab(', '// ─── App principal');
  const cut = source.search(/\n  return \(/);
  assert.ok(cut >= 0);
  // Los manejadores de los botones de modo viven en el JSX, fuera del recorte:
  // se extraen literalmente de la fuente para medir el código de producción,
  // no una reescritura.
  const handler = label => {
    const at = source.indexOf(label);
    assert.ok(at > 0, 'no se encontró el botón ' + label);
    const open = source.lastIndexOf('onClick={() => {', at);
    return source.slice(open + 'onClick={'.length, source.indexOf('}}', open) + 1);
  };
  vm.runInContext(source.slice(0, cut)
    + '\n  return {loadRestorationDocument,loadKeyFile,modifiedText,documentName,loadingDocument,'
    + 'documentLoadMessage,mappingText,status,mode,buildMapping,'
    + 'clickModoAuto: ' + handler('Usar la llave de esta sesión') + ','
    + 'clickModoGuardada: ' + handler('Usar una llave guardada') + '};\n}', context);
  return {
    context, alerts,
    dispose() { for (const fn of cleanup) fn?.(); },
    render(props = { lastResult: null }) { cursor = 0; const out = context.RecoverTab(props); for (const fn of effects.splice(0)) fn(); return out; },
  };
}

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('al restaurar, la última carga gana aunque la antigua termine después', async () => {
  const f = recoverFixture();
  const lenta = deferred();
  const rapida = deferred();
  f.context.readTextDocumentFile = file => (file.name === 'A-lento.pdf' ? lenta : rapida).promise;
  const api = f.render();
  const pa = api.loadRestorationDocument({ name: 'A-lento.pdf' });
  const pb = api.loadRestorationDocument({ name: 'B-rapido.txt' });
  rapida.resolve(f.context.makeTextDocument('B reciente'));
  await pb;
  assert.equal(f.render().modifiedText, 'B reciente');
  lenta.resolve(f.context.makeTextDocument('A antiguo'));
  await pa;
  assert.equal(f.render().modifiedText, 'B reciente', 'una carga obsoleta sobrescribió el documento vigente');
  assert.equal(f.render().documentName, 'B-rapido.txt');
});

test('el fallo tardío de una carga antigua no avisa sobre el documento vigente', async () => {
  const f = recoverFixture();
  const lenta = deferred();
  const rapida = deferred();
  f.context.readTextDocumentFile = file => (file.name === 'A' ? lenta : rapida).promise;
  const api = f.render();
  const pa = api.loadRestorationDocument({ name: 'A' });
  const pb = api.loadRestorationDocument({ name: 'B' });
  rapida.resolve(f.context.makeTextDocument('B'));
  await pb;
  lenta.reject(new Error('A falló tarde'));
  await pa;
  assert.deepEqual(f.alerts, []);
  assert.equal(f.render().modifiedText, 'B');
});

test('el indicador de lectura sigue activo mientras queda una carga en curso', async () => {
  const f = recoverFixture();
  const lenta = deferred();
  const rapida = deferred();
  f.context.readTextDocumentFile = file => (file.name === 'A' ? lenta : rapida).promise;
  const api = f.render();
  const pa = api.loadRestorationDocument({ name: 'A' });
  const pb = api.loadRestorationDocument({ name: 'B' });
  rapida.resolve(f.context.makeTextDocument('B'));
  await pb;
  assert.equal(f.render().loadingDocument, false);
  lenta.resolve(f.context.makeTextDocument('A'));
  await pa;
  assert.equal(f.render().loadingDocument, false);
});

test('desmontar la pestaña evita aplicar una lectura pendiente', async () => {
  const f = recoverFixture();
  const pendiente = deferred();
  f.context.readTextDocumentFile = () => pendiente.promise;
  const promesa = f.render().loadRestorationDocument({ name: 'A' });
  f.dispose();
  pendiente.resolve(f.context.makeTextDocument('No aplicar'));
  await promesa;
  assert.equal(f.render().modifiedText, '');
});

// La llave contiene los originales en claro: una lectura obsoleta que la pise
// haría restaurar y descargar datos reales del expediente equivocado.
const keyFile = (name, gate) => ({ name, text: () => gate });

test('la última llave elegida gana aunque la anterior termine después', async () => {
  const f = recoverFixture();
  const vieja = deferred();
  const nueva = deferred();
  const api = f.render();
  const pa = api.loadKeyFile(keyFile('LLAVE-VIEJA.tsv', vieja.promise));
  const pb = api.loadKeyFile(keyFile('LLAVE-NUEVA.tsv', nueva.promise));
  nueva.resolve('[PERSONA_1]\t"Persona nueva"');
  await pb;
  vieja.resolve('[PERSONA_1]\t"Persona vieja"');
  await pa;
  assert.match(f.render().mappingText, /Persona nueva/, 'una llave obsoleta pisó la vigente');
  assert.doesNotMatch(f.render().mappingText, /Persona vieja/);
  assert.match(f.render().status, /LLAVE-NUEVA\.tsv/);
});

test('el fallo tardío de una llave antigua no avisa sobre la llave vigente', async () => {
  const f = recoverFixture();
  const vieja = deferred();
  const nueva = deferred();
  const api = f.render();
  const pa = api.loadKeyFile(keyFile('VIEJA.tsv', vieja.promise));
  const pb = api.loadKeyFile(keyFile('NUEVA.tsv', nueva.promise));
  nueva.resolve('[PERSONA_1]\t"Vigente"');
  await pb;
  vieja.reject(new Error('fallo tardío'));
  await pa;
  assert.deepEqual(f.alerts, []);
  assert.match(f.render().mappingText, /Vigente/);
});

test('desmontar la pestaña evita aplicar una llave pendiente', async () => {
  const f = recoverFixture();
  const pendiente = deferred();
  const promesa = f.render().loadKeyFile(keyFile('A.tsv', pendiente.promise));
  f.dispose();
  pendiente.resolve('[PERSONA_1]\t"Fuga"');
  await promesa;
  assert.equal(f.render().mappingText, '', 'se aplicó una llave tras desmontar la pestaña');
});

test('volver a la llave de la sesión descarta una lectura de llave en vuelo', async () => {
  // El usuario sube por error la llave de otro expediente, se da cuenta y
  // vuelve a «Usar la llave de esta sesión» antes de que termine de leerse.
  const f = recoverFixture();
  const lenta = deferred();
  const api = f.render();
  const pendiente = api.loadKeyFile(keyFile('LLAVE-EXPEDIENTE-A.tsv', lenta.promise));
  f.render().clickModoAuto();
  assert.equal(f.render().mode, 'auto');
  lenta.resolve('[PERSONA_1]\t"ALICIA-EXPEDIENTE-A"');
  await pendiente;
  const after = f.render();
  assert.equal(after.mode, 'auto', 'la lectura obsoleta revirtió el modo elegido');
  assert.doesNotMatch(after.mappingText, /ALICIA-EXPEDIENTE-A/, 'plantó la llave de otro expediente');
  assert.doesNotMatch(after.status, /LLAVE-EXPEDIENTE-A/);
  // Y la llave efectiva sigue siendo la de la sesión, no la del archivo.
  const conSesion = f.render({ lastResult: { reps: [{ replacement: '[PERSONA_1]', original: 'BEATRIZ-EXPEDIENTE-B' }] } });
  assert.deepEqual(plain(conSesion.buildMapping()), { '[PERSONA_1]': 'BEATRIZ-EXPEDIENTE-B' });
});

test('elegir llave guardada descarta una lectura anterior en vuelo', async () => {
  const f = recoverFixture();
  const lenta = deferred();
  const api = f.render();
  const pendiente = api.loadKeyFile(keyFile('VIEJA.tsv', lenta.promise));
  f.render().clickModoGuardada();
  lenta.resolve('[PERSONA_1]\t"Vieja"');
  await pendiente;
  assert.equal(f.render().mappingText, '', 'una lectura descartada escribió la llave');
});

// ─── Inventario honesto de dependencias embebidas ─────────────────────────────

// ─── Lista de palabras visibles: debe fallar CERRADA ──────────────────────────
// Un término visible que sea subcadena de un dato sensible no puede dejarlo en
// claro, y menos aún con el semáforo en verde, que es lo que habilita copiar y
// exportar. Casos tomados del propio texto de la interfaz (escribir el dominio
// de la empresa en vez del correo completo es la variante natural).
const casosVisibles = [
  { visible: 'miempresa.com', texto: 'Escalado a ana.torres@miempresa.com y a rrhh@miempresa.com.', dato: 'ana.torres@miempresa.com' },
  { visible: '.com', texto: 'Escribe a maria.garcia@empresa.com para el alta.', dato: 'maria.garcia@empresa.com' },
  { visible: '1488', texto: 'Tarjeta 4539 1488 0343 6467 a nombre del titular.', dato: '4539 1488 0343 6467' },
  { visible: '0991', texto: 'Mi celular es 0991234567 para urgencias.', dato: '0991234567' },
  { visible: 'co', texto: 'Contacto comercial: ventas.directas@corporativo.com.ec', dato: 'ventas.directas@corporativo.com.ec' },
];

test('un término visible que es parte de un dato sensible no lo deja en claro', () => {
  const context = engine();
  const cats = vm.runInContext('CATS.filter(c => c.on)', context);
  const activos = vm.runInContext('CATS.filter(c => c.on).map(c => c.id)', context);
  for (const { visible, texto, dato } of casosVisibles) {
    const result = context.runAnonymize(texto, cats, '', { whitelist: visible });
    const riesgo = context.computeResidualRisk(result.out, activos, { whitelist: visible });
    const enClaro = result.out.includes(dato);
    // El invariante que faltaba: dato literal en la salida ⇒ el semáforo NO
    // puede estar verde, porque con hits vacío se habilita la exportación.
    assert.ok(!(enClaro && riesgo.hits.length === 0),
      'con «' + visible + '» visible, «' + dato + '» queda en claro y el semáforo está verde');
  }
});

test('un término visible cubre solo lo que coincide exactamente', () => {
  const context = engine();
  const cats = vm.runInContext('CATS.filter(c => c.on)', context);
  // El camino «No ocultar este dato» inyecta el valor completo: ese sí se respeta.
  const exacto = context.runAnonymize(
    'Escalado a ana.torres@miempresa.com y a rrhh@miempresa.com.',
    cats, '', { whitelist: 'rrhh@miempresa.com' }
  );
  assert.ok(exacto.out.includes('rrhh@miempresa.com'), 'el término exacto debe permanecer visible');
  assert.ok(!exacto.out.includes('ana.torres@miempresa.com'), 'el otro correo debía anonimizarse');
});

test('el semáforo no se blanquea borrando el término del texto que escanea', () => {
  const context = engine();
  const activos = vm.runInContext('CATS.filter(c => c.on).map(c => c.id)', context);
  // Sin anonimizar nada: el dato está entero y debe detectarse pese al término.
  const riesgo = context.computeResidualRisk(
    'Escalado a ana.torres@miempresa.com.', activos, { whitelist: 'miempresa.com' }
  );
  assert.ok(riesgo.hits.length > 0, 'el escáner perdió el correo al borrar el dominio visible');
});

test('se avisa cuando una palabra autorizada solo cubre parte de un dato', () => {
  const context = engine();
  const cats = vm.runInContext('CATS.filter(c => c.on)', context);
  const parciales = context.splittingWhitelistTerms(
    'Escalado a ana.torres@miempresa.com.', 'miempresa.com', cats
  );
  assert.deepEqual(plain(parciales), ['miempresa.com']);
  // Un término que cubre el dato completo no genera aviso.
  assert.deepEqual(plain(context.splittingWhitelistTerms(
    'Escalado a rrhh@miempresa.com.', 'rrhh@miempresa.com', cats
  )), []);
  // Y una palabra que no toca ningún dato tampoco.
  assert.deepEqual(plain(context.splittingWhitelistTerms(
    'Oficina de Quito, sin datos.', 'Quito', cats
  )), []);
  // El aviso llega al semáforo y se pinta en la interfaz.
  const semaforo = html.slice(html.indexOf('function RiskSemaphore'));
  const cuerpo = semaforo.slice(0, semaforo.indexOf('\n}\n'));
  assert.match(cuerpo, /splitTerms/, 'el semáforo no recibe los términos parciales');
  assert.match(cuerpo, /data-split-warning/, 'el semáforo no muestra el aviso');
  assert.match(html, /splitTerms=\{splitTerms\}/, 'la vista de trabajo no pasa los términos parciales');
});

test('el aviso de troceado también detecta un término que desborda el dato', () => {
  const context = engine();
  const cats = vm.runInContext('CATS.filter(c => c.on)', context);
  // El término empieza antes del dato: solapa sin estar contenido en él.
  assert.deepEqual(
    plain(context.splittingWhitelistTerms('Hola, Atte. Carla Mena café', 'Atte. Carla ', cats)),
    ['Atte. Carla']
  );
  // Y el que acaba después del dato.
  assert.deepEqual(
    plain(context.splittingWhitelistTerms('Correo ñandu@acentuado.test aquí', 'ñandu@acentua', cats)),
    ['ñandu@acentua']
  );
});

test('el troceado no emite fragmentos degenerados como entidades', () => {
  const context = engine();
  const cats = vm.runInContext("CATS.filter(c => c.id === 'address')", context);
  const texto = 'Calle Bolívar 45 Calle Bolívar 45\tCalle Bolívar 45';
  const result = context.runAnonymize(texto, cats, '', { whitelist: 'Calle Bolívar 45' });
  for (const rep of result.reps) {
    assert.match(rep.original, /\S/, 'se etiquetó un fragmento en blanco: ' + JSON.stringify(rep.original));
    assert.ok(rep.original.length > 1, 'se etiquetó un fragmento de un carácter: ' + JSON.stringify(rep.original));
  }
  // Y el round-trip conserva el tabulador exacto.
  const mapa = Object.fromEntries(result.reps.map(r => [r.replacement, r.original]));
  assert.equal(context.restoreTags(result.out, mapa).out, texto);
});

test('el respaldo con originales respeta las palabras autorizadas', () => {
  // canExport y el respaldo deben decidir con el mismo criterio: si no, el
  // botón se habilita y la descarga no ocurre sin decir nada.
  const fuente = html.slice(html.indexOf('async function downloadCombinedDoc'));
  const cuerpo = fuente.slice(0, fuente.indexOf('\n}\n'));
  // La llamada lleva paréntesis anidados: se toma hasta el fin de la sentencia.
  const at = cuerpo.indexOf('computeResidualRisk(');
  assert.ok(at >= 0, 'el respaldo no revalida el riesgo');
  const llamada = cuerpo.slice(at, cuerpo.indexOf('\n', at));
  assert.match(llamada, /whitelist/, 'el respaldo revalida sin la lista autorizada: ' + llamada);
  // Y quien lo invoca debe pasarla.
  for (const m of html.matchAll(/downloadCombinedDoc\(\{/g)) {
    const bloque = html.slice(m.index, html.indexOf('})', m.index));
    assert.match(bloque, /whitelist/, 'una llamada al respaldo omite la lista autorizada');
  }
});

test('toda lectura asíncrona de archivos lleva guarda de generación', () => {
  // Regla estructural: el defecto fue tener la guarda en una lectura y no en
  // la otra. Cualquier manejador nuevo debe traerla desde el primer día.
  const tabs = ['function WorkTab(', 'function RecoverTab('];
  for (const marker of tabs) {
    const start = html.indexOf(marker);
    const body = html.slice(start, html.indexOf('\n}\n', html.indexOf('return (', start)));
    const handlers = [...body.matchAll(/const (\w+) = async (?:file|\(file\))[^=]*=> \{/g)].map(m => m[1]);
    assert.ok(handlers.length, 'no se encontraron manejadores de archivo en ' + marker);
    for (const name of handlers) {
      const from = body.indexOf('const ' + name + ' = async');
      const fn = body.slice(from, body.indexOf('\n  };', from));
      assert.match(fn, /\+\+\w*[Gg]eneration\.current/, name + ' no toma una generación');
      assert.match(fn, /const isCurrent = \(\) =>/, name + ' no define isCurrent');
      assert.ok((fn.match(/if \(!isCurrent\(\)\) return/g) || []).length >= 2,
        name + ' no revalida tras await antes de aplicar y en el catch');
    }
  }
  // El desmontaje debe invalidar TODAS las generaciones declaradas.
  const recover = html.slice(html.indexOf('function RecoverTab('), html.indexOf('// ─── App principal'));
  const declaradas = [...recover.matchAll(/const (\w*[Gg]eneration) = useRef\(0\)/g)].map(m => m[1]);
  const cleanup = recover.match(/useEffect\(\(\) => \(\) => \{([^}]+)\}/)[1];
  for (const name of declaradas) assert.ok(cleanup.includes(name), 'el desmontaje no invalida ' + name);

  // Y toda escritura de la llave o del modo FUERA de loadKeyFile debe invalidar
  // su generación: si no, una lectura en vuelo la pisa al terminar.
  const key = recover.indexOf('const loadKeyFile');
  const sinLoadKey = recover.slice(0, key) + recover.slice(recover.indexOf('\n  };', key));
  for (const m of sinLoadKey.matchAll(/(setMode|setMappingText)\(/g)) {
    const linea = sinLoadKey.slice(sinLoadKey.lastIndexOf('\n', m.index) + 1, sinLoadKey.indexOf('\n', m.index));
    assert.match(linea, /keyReadGeneration\.current\+\+/,
      'escribe la llave o el modo sin invalidar la lectura en vuelo: ' + linea.trim().slice(0, 110));
  }
});

test('todos los hooks de React usados están desestructurados', () => {
  // Un hook sin desestructurar deja la pestaña en blanco al renderizarse, y
  // solo se ve en el navegador: aquí se comprueba sobre la fuente.
  // slice() corta en el primer '</script>' del documento, que está antes del
  // script de la app: aquí se recorta desde la desestructuración al final.
  const app = html.slice(html.indexOf('const { useState'));
  const declaracion = app.match(/const \{([^}]+)\} = React;/);
  assert.ok(declaracion, 'no se encontró la desestructuración de hooks de React');
  const declarados = new Set(declaracion[1].split(',').map(s => s.trim()));
  const usados = new Set([...app.matchAll(/(?<![.\w])(use[A-Z]\w+)\s*\(/g)].map(m => m[1]));
  const propios = new Set(['useSettings', 'useDialog']);
  for (const hook of usados) {
    if (propios.has(hook) || app.includes('function ' + hook + '(')) continue;
    assert.ok(declarados.has(hook), 'hook usado sin desestructurar de React: ' + hook);
  }
  assert.ok(declarados.has('useEffect'));
});

test('el inventario declara las dependencias que viajan dentro de bundles preempaquetados', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../vendor/mammoth-browser/bundle-manifest.json', import.meta.url), 'utf8'));
  const bytes = fs.readFileSync(new URL('../vendor/mammoth-browser/mammoth.browser.min.js', import.meta.url), 'utf8');
  // jszip entra como un único archivo ya empaquetado: sus dependencias no las ve
  // el listado de archivos, pero sus bytes sí están en el bundle que se sirve.
  assert.match(bytes, /invalid distance too far back/, 'el bundle debe contener el inflador de pako');
  for (const nombre of ['pako', 'lie', 'setimmediate', 'immediate']) {
    assert.ok(manifest.embeddedPackages[nombre], 'sin declarar en el inventario: ' + nombre);
    assert.match(manifest.embeddedPackages[nombre][0], /^\d+\.\d+\.\d+$/);
  }
  assert.ok(manifest.prepackagedSources?.jszip, 'debe declararse de dónde salen esas dependencias no visibles');
});

test('el inventario no declara dependencias ausentes de los bytes servidos', () => {
  // Declarar de más también engaña: el informe de auditoría afirmaría servir
  // código que no se sirve. readable-stream lo sustituye el mapa "browser" de
  // jszip por un stub, y argparse/sprintf-js solo sirven a la CLI de Node.
  const manifest = JSON.parse(fs.readFileSync(new URL('../vendor/mammoth-browser/bundle-manifest.json', import.meta.url), 'utf8'));
  const bytes = fs.readFileSync(new URL('../vendor/mammoth-browser/mammoth.browser.min.js', import.meta.url), 'utf8');
  for (const ausente of ['readable-stream', 'string_decoder', 'safe-buffer', 'util-deprecate', 'core-util-is', 'argparse', 'sprintf-js']) {
    assert.ok(!manifest.embeddedPackages[ausente], 'declara un paquete que no está en los bytes: ' + ausente);
  }
  // Y los marcadores de esos paquetes tampoco deben aparecer.
  for (const marcador of ['_readableState', 'StringDecoder', 'ArgumentParser']) {
    assert.ok(!bytes.includes(marcador), 'el bundle contiene ' + marcador + ' sin declararlo');
  }
  assert.deepEqual(Object.keys(manifest.prepackagedSources), ['jszip']);
});

test('la valoración de la auditoría cita las versiones reales del paquete', () => {
  const script = fs.readFileSync(new URL('../scripts/auditar-produccion.mjs', import.meta.url), 'utf8');
  const valoracion = script.slice(script.indexOf('assessment:'));
  for (const obsoleta of ['3.11.174', 'Mammoth 1.8.0', '0.8.6', '3.7.1', '1.13.1']) {
    assert.ok(!valoracion.includes(obsoleta), 'la valoración cita una versión que ya no se sirve: ' + obsoleta);
  }
  assert.match(valoracion, /runtimePackages|embeddedInventory|runtime\[/, 'las versiones deben derivarse del manifiesto');
});

test('el alojamiento sirve la misma CSP que el servidor verificado', () => {
  // El paquete protege con CSP, pero quien la envía en producción es el
  // alojamiento: sin esta cabecera el sitio público queda sin la defensa.
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'));
  const headers = vercel.headers.flatMap(rule => rule.headers);
  const csp = headers.find(h => h.key === 'Content-Security-Policy');
  assert.ok(csp, 'el alojamiento no envía Content-Security-Policy');
  // Debe coincidir con la CSP del paquete, más frame-ancestors coherente con DENY.
  assert.ok(csp.value.startsWith(manifest.security.csp), 'la CSP del alojamiento difiere de la verificada');
  assert.match(csp.value, /frame-ancestors 'none'/);
  assert.ok(!csp.value.includes('unsafe-eval'));
  const frame = headers.find(h => h.key === 'X-Frame-Options');
  assert.equal(frame.value, 'DENY', 'X-Frame-Options debe concordar con frame-ancestors none');
  // Y el despliegue debe publicar el paquete, no el repositorio.
  assert.equal(vercel.outputDirectory, 'dist');
  assert.match(vercel.buildCommand, /npm run build/);
});

test('ningún icono de categoría usa un emoji que la fuente no dibuja', () => {
  // 🪪 (U+1FAA9, Emoji 14) no existe en las fuentes de sistema de Windows ni
  // Android antiguos: sale un cuadro vacío junto al dato procesado, que es
  // justo donde el usuario necesita confiar en el resultado.
  const sinSoporteAmplio = ['\u{1FAA9}', '\u{1FAE0}', '\u{1FAE1}', '\u{1FAE2}', '\u{1FAE3}',
    '\u{1FAE4}', '\u{1FAE5}', '\u{1FAE6}', '\u{1FAE7}', '\u{1FAA8}', '\u{1FAAA}', '\u{1FAAB}',
    '\u{1FAAC}', '\u{1FAAD}', '\u{1FAAE}', '\u{1FAAF}'];
  const iconos = [...html.matchAll(/icon:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(iconos.length >= 10, 'no se encontraron los iconos de categoría');
  for (const icono of iconos) {
    for (const ch of sinSoporteAmplio) {
      assert.ok(!icono.includes(ch), 'icono sin soporte de fuente: ' + JSON.stringify(icono));
    }
  }
});

test('la tabla de equivalencias no parte palabras por la mitad', () => {
  // break-all corta dentro de la palabra: una IP sale como «192.16 / 8.1.44»,
  // que parece un dato corrupto en lugar de un salto de línea.
  const tabla = html.slice(html.indexOf('>Dato original<'), html.indexOf('</table>', html.indexOf('>Dato original<')));
  assert.ok(tabla.length > 100, 'no se localizó la tabla de equivalencias');
  assert.ok(!/break-all/.test(tabla), 'la tabla usa break-all y parte palabras');
  assert.match(tabla, /break-words|anywhere/, 'la tabla debe permitir quebrar solo cuando no cabe');
});

test('los controles de vista del resultado se ven pulsables', () => {
  // Eran dos líneas en negrita sin borde ni fondo: se leían como subtítulos.
  for (const etiqueta of ['Ver original y resultado', 'Ver como documento']) {
    const at = html.indexOf(etiqueta);
    assert.ok(at > 0, 'no se encontró el control ' + etiqueta);
    const apertura = html.lastIndexOf('<button', at);
    const clases = html.slice(apertura, at);
    assert.match(clases, /border/, etiqueta + ' no tiene borde visible');
  }
});

test('la barra de pestañas no deja secciones invisibles en móvil', () => {
  // A 360 px solo caben 2 de 5 pestañas y la pista era un texto gris de 12 px.
  // Debe haber un control explícito (menú) para alcanzar las demás.
  const bar = html.slice(html.indexOf('role="tablist"') - 400, html.indexOf('role="tablist"') + 2600);
  assert.match(bar, /aria-label="[^"]*secciones|data-tab-menu/, 'no hay control accesible para las secciones ocultas');
});
