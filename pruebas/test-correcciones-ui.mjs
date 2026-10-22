// Pruebas Node de lógica y efectos: no controlan ni abren un navegador.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const engine = html.slice(html.indexOf('function cn('), html.indexOf('// ─── Texto de muestra'));
const slice = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
function componentLogic(name, end, returned) {
  const source = slice('function ' + name + '(', end);
  const cut = source.search(/\n  return (?:\(|ReactDOM\.createPortal\()/);
  assert.ok(cut !== -1, 'retorno principal de ' + name);
  return source.slice(0, cut) + '\n  return ' + returned + ';\n}';
}
function hooks(initial = []) {
  const slots = [], pending = [], cleanups = [];
  let cursor = 0;
  return {
    slots,
    begin() { cursor = 0; },
    commit() { for (const run of pending.splice(0)) run(); },
    dispose() { for (const cleanup of cleanups) cleanup?.(); },
    useState(value) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = i in initial ? initial[i] : typeof value === 'function' ? value() : value;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(value) { const i = cursor++; return slots[i] ||= {current:value}; },
    useMemo(factory, deps) {
      const i = cursor++;
      if (!(i in slots) || deps.some((d, n) => !Object.is(d, slots[i].deps[n]))) slots[i] = {deps, value: factory()};
      return slots[i].value;
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!(i in slots) || deps.some((d, n) => !Object.is(d, slots[i][n]))) {
        slots[i] = deps;
        pending.push(() => { cleanups[i]?.(); cleanups[i] = effect(); });
      }
    },
    useLayoutEffect(effect, deps) { this.useEffect(effect, deps); },
    useContext() { return this.dialogs; },
    createContext() { return {}; },
    dialogs: { alert: async () => true, confirm: async () => true, notify() {} },
  };
}
function context(h, extra = {}) {
  const ctx = vm.createContext({ React:h, useState:h.useState.bind(h), useRef:h.useRef.bind(h), useMemo:h.useMemo.bind(h), useEffect:h.useEffect.bind(h), Intl,
    window:{confirm:()=>true, addEventListener(){}, removeEventListener(){}}, setTimeout:()=>{}, useDialog:()=>h.dialogs, ...extra });
  vm.runInContext(engine, ctx);
  vm.runInContext(slice('// ─── Modelo de documentos textuales', '// ─── Fin modelo de documentos textuales'), ctx);
  return ctx;
}
// Índices de estado de WorkTab, en orden de declaración (los ajustes viven en App y llegan por props).
const W = { inputText:0, sourceName:1, result:2, reviewed:3 };
// Ajustes falsos: mismo contrato que useSettings().
function fakeSettings(ctx, over = {}) {
  const st = { cats: vm.runInContext('CATS', ctx).map(c => ({...c})), customTerms:'', whitelist:'', version:0 };
  return Object.assign(st, {
    toggleCat(id){ st.cats = st.cats.map(c => c.id===id && !c.alwaysOn ? {...c, on:!c.on} : c); st.version++; },
    applyPreset(){ st.version++; }, setCatsForTemplate(){ st.version++; },
    updateCustomTerms(v){ st.customTerms=v; st.version++; }, updateWhitelist(v){ st.whitelist=v; st.version++; },
    addCustomTerm(t){ st.customTerms = (st.customTerms.trim()? st.customTerms+'\n':'') + t; st.version++; },
    addWhitelistTerm(t){ st.whitelist = (st.whitelist.trim()? st.whitelist+'\n':'') + t; st.version++; },
    reset(){}, ...over });
}
const mount = (ctx, h, extra = {}) => ctx.WorkTab({setLastResult:()=>{}, settings: ctx.__settings ||= fakeSettings(ctx), onOpenSettings(){}, ...extra});
const original = '  María\tGarcía\r\nLópez  ';
const rep = {replacement:'[PERSONA_1]', original, catId:'person', catLabel:'Persona', hint:null, count:1, valid:null};
test('copiar llave utiliza el mapa JSON reversible con columnas completas', async () => {
  const h = hooks(); h.slots[W.result] = {out:'[PERSONA_1]', reps:[rep]};
  let clipboard;
  const ctx = context(h, {copyLocalText:async text => {clipboard=text;return true;}});
  vm.runInContext(componentLogic('WorkTab', '// ─── Pestaña Recuperar', '{copyTable}'), ctx);
  h.begin(); await mount(ctx, h).copyTable();
  await Promise.resolve(); await Promise.resolve();
  assert.match(clipboard, /Original \(JSON\)/);
  assert.equal(ctx.parseEquivalences(clipboard)['[PERSONA_1]'], original);
  assert.equal(clipboard.split('\n')[1].split('\t').length, 4);
});
test('copiar llave cancelada no escribe en el portapapeles', async () => {
  const h = hooks(); h.slots[W.result] = {out:'[PERSONA_1]', reps:[rep]};
  h.dialogs = { ...h.dialogs, confirm: async () => false };
  let clipboard = null;
  const ctx = context(h, {copyLocalText:async text => {clipboard=text;return true;}});
  vm.runInContext(componentLogic('WorkTab', '// ─── Pestaña Recuperar', '{copyTable}'), ctx);
  h.begin(); await mount(ctx, h).copyTable();
  assert.equal(clipboard, null);
});
test('Recuperar decodifica mapa JSON sin modificar espacios, TAB ni CRLF', () => {
  const h = hooks();
  h.dialogs = { ...h.dialogs, alert: message => assert.fail(message) };
  const ctx = context(h);
  h.slots[0]='paste'; h.slots[1]=ctx.serializeEquivalences([rep]); h.slots[2]='[PERSONA_1]';
  vm.runInContext(componentLogic('RecoverTab', '// ─── App principal', '{recover}'), ctx);
  h.begin(); ctx.RecoverTab({lastResult:null}).recover();
  assert.equal(h.slots[3].out, original);
});
test('Recuperar explica un mapa inválido sin excepción sin manejar ni resultado', () => {
  const alerts = [];
  const h = hooks(['paste', 'Etiqueta\tOriginal (JSON)\n[PERSONA_1]\tJSON roto', '[PERSONA_1]', null]);
  h.dialogs = { ...h.dialogs, alert: (message) => { alerts.push(message); } };
  const ctx = context(h);
  vm.runInContext(componentLogic('RecoverTab', '// ─── App principal', '{recover}'), ctx);
  h.begin();
  assert.doesNotThrow(() => ctx.RecoverTab({lastResult:null}).recover());
  assert.ok(alerts.some(message=>/formato|inv[aá]lido/i.test(message)));
  assert.equal(h.slots[3], null);
});
test('Recuperar repara etiquetas alteradas por el modelo', () => {
  const h = hooks();
  const ctx = context(h);
  h.slots[0]='auto'; h.slots[2]='Hola [PERSONA 1] y persona_1.';
  vm.runInContext(componentLogic('RecoverTab', '// ─── App principal', '{recover}'), ctx);
  h.begin(); ctx.RecoverTab({lastResult:{reps:[{replacement:'[PERSONA_1]', original:'Ana'}]}}).recover();
  assert.equal(h.slots[3].out, 'Hola Ana y Ana.');
  assert.equal(h.slots[3].repaired.length, 2);
});
test('tabla del respaldo DOC pegada como TSV también restaura el original exacto', async () => {
  const h = hooks(); let body;
  const ctx = context(h, {downloadWordDoc:(_name,_title,html)=>{body=html;}});
  vm.runInContext(slice('function escXml(', 'async function copyLocalText(') +
    slice('async function downloadCombinedDoc(', '// ─── Visor de documento modal'), ctx);
  const done = await ctx.downloadCombinedDoc({anonText:'[PERSONA_1]',reps:[rep],cats:[],activeCats:[],timestamp:'fixture',originalLen:original.length,reviewed:true,confirm:async()=>true});
  assert.equal(done, true);
  const table = body.match(/<table>([\s\S]*?)<\/table>/)[1];
  const unescape = text => text.replace(/<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  const tsv = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell=>unescape(cell[1])).join('\t')).join('\n');
  assert.match(tsv, /Original \(JSON\)/);
  assert.equal(ctx.parseEquivalences(tsv)['[PERSONA_1]'], original);
});
function viewerFixture() {
  const h = hooks();
  const listeners = new Map();
  const root = {inert:false};
  const doc = {getElementById:()=>root, addEventListener:(name,fn)=>listeners.set(name,fn), removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const node = () => ({isConnected:true, focus(){doc.activeElement=this;}, getClientRects:()=>[{}], closest:()=>null});
  const opener = node(), first = node(), last = node();
  doc.activeElement=opener;
  const dialog = {...node(), querySelectorAll:()=>[first,last], contains:target=>[dialog,first,last].includes(target)};
  const ctx = context(h, {document:doc});
  vm.runInContext(componentLogic('DocumentViewer', '// ─── Pestaña Cómo usar', '{reviewed,setReviewed,dialogRef:typeof dialogRef === "undefined" ? null : dialogRef}'), ctx);
  const render = props => {
    h.begin(); const result=ctx.DocumentViewer(props);
    if(result?.dialogRef)result.dialogRef.current=dialog;
    h.commit(); return result;
  };
  const key = (key,shiftKey=false) => {
    const event={key,shiftKey,prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){}};
    listeners.get('keydown')?.(event); return event;
  };
  return {h,root,doc,listeners,opener,first,last,dialog,render,key};
}
const props = (identity, onClose=()=>{}) => ({open:true,onClose,anonText:'[PERSONA_1]',reps:[rep],cats:[],activeCats:[],resultIdentity:identity});
const viewerSlot = h => h.slots.find(s => s && typeof s === 'object' && 'generation' in s && 'anonText' in s);
test('la vista de trabajo asigna una generación nueva por resultado, aunque el texto sea idéntico', () => {
  const h = hooks(); const ctx = context(h);
  h.slots[W.inputText] = 'Paciente: María García.';
  vm.runInContext(componentLogic('WorkTab', '// ─── Pestaña Recuperar', '{anonymize, openViewer}'), ctx);
  const run = method => { h.begin(); mount(ctx, h)[method](); };
  run('anonymize'); run('openViewer');
  const first = { ...viewerSlot(h) };
  run('anonymize'); run('openViewer');
  const second = viewerSlot(h);
  assert.equal(first.anonText, second.anonText);
  assert.equal(typeof first.generation, 'number');
  assert.ok(second.generation > first.generation);
  assert.match(slice('function WorkTab(', '// ─── Pestaña Recuperar'), /resultIdentity=\{viewerData\.generation\}/);
});
test('el resultado se invalida al cambiar ajustes (desde la pestaña Ajustes) o al dejar visible una etiqueta', () => {
  const h = hooks(); const ctx = context(h);
  h.slots[W.inputText] = 'Cliente: Ana Ruiz'; h.slots[W.result] = {out:'x', reps:[]};
  vm.runInContext(componentLogic('WorkTab', '// ─── Pestaña Recuperar', '{excludeFromResult}'), ctx);
  const settings = fakeSettings(ctx);
  h.begin(); mount(ctx, h, {settings}); h.commit();          // primer render: fija la versión inicial
  settings.toggleCat('email');                               // cambio hecho en Ajustes
  h.begin(); mount(ctx, h, {settings}); h.commit();          // re-render de WorkTab con la nueva versión
  assert.equal(h.slots[W.result], null, 'el resultado debe quedar obsoleto al cambiar un tipo en Ajustes');
  h.slots[W.result] = {out:'x', reps:[]};
  h.begin(); mount(ctx, h, {settings}).excludeFromResult({original:'Acme'});
  assert.equal(h.slots[W.result], null);
  assert.match(settings.whitelist, /Acme/);
});
test('visor invalida revisión ante una identidad nueva con anonText idéntico', () => {
  const f = viewerFixture(); const identity={}; const same=props(identity);
  let result=f.render(same); assert.equal(result.reviewed,false);
  result.setReviewed(true); result=f.render(same); assert.equal(result.reviewed,true);
  result=f.render(props({})); assert.equal(result.reviewed,false);
  f.h.dispose();
});
test('visor usa portal fuera de root, inert, foco inicial y restauración', () => {
  const f=viewerFixture(); f.render(props({}));
  assert.equal(f.root.inert,true);
  assert.equal(f.doc.activeElement,f.first);
  const source=slice('function DocumentViewer(', '// ─── Pestaña Cómo usar');
  assert.match(source, /return ReactDOM\.createPortal\(/);
  assert.match(source, /document\.body\s*\)/);
  f.h.dispose();
  assert.equal(f.root.inert,false); assert.equal(f.doc.activeElement,f.opener);
  assert.equal(f.listeners.size,0);
});
test('visor atrapa Tab/Shift+Tab, recupera foco exterior y cierra con Escape', () => {
  const f=viewerFixture(); let closed=0; f.render(props({},()=>closed++));
  f.last.focus(); assert.equal(f.key('Tab').prevented,true); assert.equal(f.doc.activeElement,f.first);
  assert.equal(f.key('Tab',true).prevented,true); assert.equal(f.doc.activeElement,f.last);
  f.opener.focus(); f.listeners.get('focusin')?.({target:f.opener}); assert.equal(f.doc.activeElement,f.first);
  assert.equal(f.key('Escape').prevented,true); assert.equal(closed,1);
  f.h.dispose();
});
test('la impresión respeta «Sin marcas», no incluye pistas de rango y no usa window.open', () => {
  const source = slice('function DocumentViewer(', '// ─── Pestaña Cómo usar');
  assert.ok(!/window\.open\(/.test(source));
  assert.match(source, /showMarks\) return '<mark/);
  assert.ok(!/rep\.hint \? part \+ ' \('/.test(source));
});
test('ninguna pestaña usa alert/confirm nativos (solo el fallback documentado de downloadCombinedDoc)', () => {
  const ui = html.slice(html.indexOf('// ─── Componentes UI base'));
  const natives = (ui.match(/^.*(?<![\w.])(?:window\.)?(?:alert|confirm)\(.*$/gm) || []).filter(line => !/Promise\.resolve\(window\.confirm\(/.test(line));
  assert.deepEqual(natives, [], natives.join('\n'));
});

test('descarga pendiente se cancela si se desmonta el resultado por edición o ajustes', async () => {
  const h=hooks(); let finish, saved=0;
  const gate=new Promise(r=>finish=r);
  const ctx=context(h,{ saveTextDocument:async (_model,_format,_kind,options)=>{await gate;if(options.canSave())saved++;} });
  vm.runInContext(componentLogic('TextDocumentDownload','function useSettings()', '{download}'),ctx);
  h.begin(); const api=ctx.TextDocumentDownload({model:{text:'[EMAIL_1]',blocks:[]},enabled:true});h.commit();
  const job=api.download();h.dispose();finish();await job;
  assert.equal(saved,0,'un resultado desmontado no puede descargarse');
});
test('la lectura de un archivo suspende exportación sin destruir el resultado anterior', async () => {
  const h=hooks();let finish;
  const gate=new Promise(r=>finish=r);
  const ctx=context(h);ctx.readTextDocumentFile=()=>gate;
  h.slots[W.inputText]='Sin datos sensibles';h.slots[W.result]={out:'Sin datos sensibles',reps:[]};h.slots[W.reviewed]=true;
  vm.runInContext(componentLogic('WorkTab','// ─── Pestaña Recuperar','{handleFile,canExport}'),ctx);
  h.begin();let api=mount(ctx,h);assert.equal(api.canExport,true);
  const job=api.handleFile({name:'nuevo.txt'});h.begin();api=mount(ctx,h);
  assert.equal(api.canExport,false,'exportación se suspende mientras se lee otro archivo');
  finish(ctx.makeTextDocument('Texto nuevo'));await job;
  assert.equal(h.slots[W.result],null,'la carga correcta invalida el resultado anterior');
});
