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
    useEffect(effect, deps) {
      const i = cursor++;
      if (!(i in slots) || deps.some((d, n) => !Object.is(d, slots[i][n]))) {
        slots[i] = deps;
        pending.push(() => { cleanups[i]?.(); cleanups[i] = effect(); });
      }
    },
    useLayoutEffect(effect, deps) { this.useEffect(effect, deps); },
  };
}
function context(h, extra = {}) {
  const ctx = vm.createContext({ React:h, useState:h.useState.bind(h), useRef:h.useRef.bind(h), Intl,
    window:{confirm:()=>true}, setTimeout:()=>{}, ...extra });
  vm.runInContext(engine, ctx);
  return ctx;
}
const original = '  María\tGarcía\r\nLópez  ';
const rep = {replacement:'[PERSONA_1]', original, catId:'person', catLabel:'Persona', hint:null};
test('copyTable utiliza el mapa JSON reversible con columnas completas', async () => {
  const h = hooks(['', {out:'[PERSONA_1]', reps:[rep]}, false]);
  let clipboard;
  const ctx = context(h, {copyLocalText:async text => {clipboard=text;return true;}});
  vm.runInContext(componentLogic('AnonTab', '// ─── Pestaña Documento', '{copyTable}'), ctx);
  h.begin(); ctx.AnonTab({setLastResult:()=>{}}).copyTable();
  await Promise.resolve();
  assert.match(clipboard, /Original \(JSON\)/);
  assert.equal(ctx.parseEquivalences(clipboard)['[PERSONA_1]'], original);
  assert.equal(clipboard.split('\n')[1].split('\t').length, 4);
});
test('Recuperar decodifica mapa JSON sin modificar espacios, TAB ni CRLF', () => {
  const h = hooks();
  const ctx = context(h, {alert:message=>assert.fail(message)});
  h.slots[0]='paste'; h.slots[1]=ctx.serializeEquivalences([rep]); h.slots[2]='[PERSONA_1]';
  vm.runInContext(componentLogic('RecoverTab', '// ─── App principal', '{recover}'), ctx);
  h.begin(); ctx.RecoverTab({lastResult:null}).recover();
  assert.equal(h.slots[3].out, original);
});
test('Recuperar explica un mapa inválido sin excepción sin manejar ni resultado', () => {
  const alerts = [];
  const h = hooks(['paste', 'Etiqueta\tOriginal (JSON)\n[PERSONA_1]\tJSON roto', '[PERSONA_1]', null]);
  const ctx = context(h, {alert:message=>alerts.push(message)});
  vm.runInContext(componentLogic('RecoverTab', '// ─── App principal', '{recover}'), ctx);
  h.begin();
  assert.doesNotThrow(() => ctx.RecoverTab({lastResult:null}).recover());
  assert.ok(alerts.some(message=>/formato|inv[aá]lido/i.test(message)));
  assert.equal(h.slots[3], null);
});
test('tabla del respaldo DOC pegada como TSV también restaura el original exacto', () => {
  const h = hooks(); let body;
  const ctx = context(h, {downloadWordDoc:(_name,_title,html)=>{body=html;}});
  vm.runInContext(slice('function escXml(', 'async function copyLocalText(') +
    slice('function downloadCombinedDoc(', '// ─── Visor de documento modal'), ctx);
  ctx.downloadCombinedDoc({anonText:'[PERSONA_1]',reps:[rep],cats:[],activeCats:[],timestamp:'fixture',originalLen:original.length,reviewed:true});
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
test('Documento asigna una generación nueva por resultado, aunque el texto sea idéntico', () => {
  const h = hooks(); const ctx = context(h);
  h.slots[4] = {name:'fixture.txt',text:'Paciente: María García.'};
  vm.runInContext(componentLogic('DocumentTab', '// ─── Pestaña Recuperar', '{anonymizeAndOpen}'), ctx);
  h.begin(); ctx.DocumentTab({setLastResult:()=>{}}).anonymizeAndOpen();
  const first = h.slots[6];
  h.begin(); ctx.DocumentTab({setLastResult:()=>{}}).anonymizeAndOpen();
  const second = h.slots[6];
  assert.equal(first.anonText,second.anonText);
  assert.equal(typeof first.generation,'number');
  assert.ok(second.generation > first.generation);
  assert.match(slice('function DocumentTab(', '// ─── Pestaña Recuperar'), /resultIdentity=\{viewerData\.generation\}/);
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
