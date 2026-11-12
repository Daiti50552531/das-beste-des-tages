// Testgerüst: liefert die App über einen kleinen lokalen Server aus und ersetzt
// Supabase im Browser durch eine Nachbildung mit denselben Sichtbarkeitsregeln
// (jede Person sieht nur ihre eigenen Zeilen, bei "Wir zwei" zusätzlich die der
// verknüpften Person). So laufen die Tests ohne Netz und ohne echte Daten.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
function load(name) {
  try { return require(name); } catch (e) { /* nicht lokal installiert */ }
  // globale Installation (z. B. /opt/node22/lib/node_modules)
  const globalDir = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules');
  return createRequire(globalDir + '/')(name);
}
const { chromium } = load('playwright');
export const XLSX = load('xlsx');
export const JSZip = load('jszip');
const XLSX_LIB = fs.readFileSync(require.resolve('xlsx/dist/xlsx.full.min.js'), 'utf8');
const JSZIP_LIB = fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'), 'utf8');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
export async function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('x'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

export const iso = (off = 0) => {
  const d = new Date(); d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const isoYearsAgo = (n) => {
  const d = new Date();
  return `${d.getFullYear() - n}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Läuft im Browser anstelle von supabase-js und fuse.js.
// window.__db hält die Tabellen, window.__uid die angemeldete Person, window.__maxRows die Zeilengrenze des Servers.
function browserStub(db) {
  if (window.__stubbed) return; window.__stubbed = true;
  window.Fuse = class { constructor(c) { this.c = c; } setCollection(c) { this.c = c; }
    search(t) { return (this.c || []).filter(e => (e.best_of_day || '').toLowerCase().includes(String(t).toLowerCase())).map(item => ({ item })); } };
  // Die Daten überleben ein Neuladen der Seite, wie bei einem echten Server
  window.__db = JSON.parse(sessionStorage.getItem('__db') || 'null') || db;
  window.addEventListener('pagehide', () => { try { sessionStorage.setItem('__db', JSON.stringify(window.__db)); } catch (e) {} });
  window.__maxRows = 1000;
  window.__calls = [];
  window.__invokes = [];
  const uid = () => window.__uid;
  const partnerOf = (u) => (window.__db.partnerships.find(x => x.user_id === u) || {}).partner_id;
  function visible(t, rows) {
    const me = uid();
    if (t === 'shared_entries') return rows.filter(r => r.user_id === me || r.user_id === partnerOf(me));
    if (t === 'entry_likes') return rows.filter(l => l.user_id === me || (window.__db.shared_entries.find(e => e.id === l.entry_id) || {}).user_id === me);
    if (t === 'partnerships' || t === 'entries' || t === 'push_subscriptions') return rows.filter(r => r.user_id === me);
    if (t === 'profiles') return rows.filter(r => r.id === me);
    return rows;
  }
  const newId = (p) => p + Math.random().toString(36).slice(2, 10);
  function exec(st) {
    const t = st.table, dbx = window.__db; dbx[t] = dbx[t] || [];
    window.__calls.push(st.op + ':' + t);
    if (window.__offline) return { data: null, error: { message: 'Failed to fetch' }, count: null };
    const one = (r) => (st.single || st.maybe) ? r : (r ? [r] : []);
    const match = (r) => st.filters.every(([c, v]) => r[c] === v);
    if (st.op === 'select') {
      let v = visible(t, dbx[t]).filter(match);
      for (const [col, asc] of [...st.orders].reverse()) v = [...v].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      const count = st.count ? v.length : null;
      if (st.head) return { data: null, error: null, count };
      if (st.range) v = v.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) v = v.slice(0, st.limit);
      v = v.slice(0, window.__maxRows);   // Zeilengrenze des Servers, unabhängig von limit/range
      if (st.maybe) return { data: v[0] || null, error: null, count };
      if (st.single) return { data: v[0] || null, error: v[0] ? null : { message: 'none' }, count };
      return { data: v.map(r => ({ ...r })), error: null, count };
    }
    if (st.op === 'upsert' || st.op === 'insert') {
      const r = st.payload;
      if (Array.isArray(r)) { r.forEach(x => dbx[t].push({ id: newId('i'), user_id: uid(), ...x })); return { data: null, error: null }; }
      if (t === 'shared_entries') {
        if (r.user_id !== uid()) return { data: null, error: { message: 'rls' } };
        let ex = dbx[t].find(x => x.user_id === r.user_id && x.entry_date === r.entry_date);
        if (ex && st.op === 'insert') return { data: null, error: { message: 'duplicate' } };
        if (ex) { ex.text = r.text; ex.updated_at = new Date().toISOString(); }
        else { ex = { id: newId('n'), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r }; dbx[t].push(ex); }
        return { data: one({ ...ex }), error: null };
      }
      if (t === 'entry_likes') {
        const e = dbx.shared_entries.find(x => x.id === r.entry_id);
        if (!e || e.user_id !== partnerOf(uid())) return { data: null, error: { message: 'rls' } };
        if (dbx[t].some(l => l.entry_id === r.entry_id)) return { data: null, error: { message: 'duplicate' } };
        dbx[t].push({ entry_id: r.entry_id, user_id: uid(), created_at: new Date().toISOString() });
        return { data: null, error: null };
      }
      if (t === 'push_subscriptions') {
        const ex = dbx[t].find(x => x.endpoint === r.endpoint);
        if (ex) Object.assign(ex, r); else dbx[t].push({ id: newId('p'), ...r });
        return { data: null, error: null };
      }
      const row = { id: newId('i'), ...r }; dbx[t].push(row);
      return { data: one(row), error: null };
    }
    if (st.op === 'update') { visible(t, dbx[t]).filter(match).forEach(r => Object.assign(r, st.payload)); return { data: null, error: null }; }
    if (st.op === 'delete') {
      const own = (r) => t === 'shared_entries' || t === 'entry_likes' || t === 'entries' ? r.user_id === uid() : true;
      dbx[t] = dbx[t].filter(r => !(match(r) && own(r)));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
  function q(table) {
    const st = { table, filters: [], orders: [], op: 'select', payload: null };
    const b = {
      select(c, o) { if (o && o.head) st.head = true; if (o && o.count) st.count = true; return b; },
      order(col, o) { st.orders.push([col, !(o && o.ascending === false)]); return b; },
      limit(n) { st.limit = n; return b; }, range(a, z) { st.range = [a, z]; return b; }, in() { return b; },
      eq(c, v) { st.filters.push([c, v]); return b; },
      insert(r) { st.op = 'insert'; st.payload = r; return b; }, upsert(r) { st.op = 'upsert'; st.payload = r; return b; },
      update(r) { st.op = 'update'; st.payload = r; return b; }, delete() { st.op = 'delete'; return b; },
      single() { st.single = true; return b; }, maybeSingle() { st.maybe = true; return b; },
      then(res, rej) { return Promise.resolve().then(() => exec(st)).then(res, rej); }
    };
    return b;
  }
  const ok = async () => ({ data: null, error: null });
  window.supabase = { createClient: (url, key) => { window.__clientKey = key; return {
    auth: {
      getSession: async () => ({ data: { session: uid() ? { user: { id: uid() }, access_token: 't' } : null } }),
      onAuthStateChange() {}, signOut: ok, resetPasswordForEmail: ok, updateUser: ok,
      signInWithPassword: async (a) => { window.__signin = a; return window.__signinResult || { data: {}, error: null }; },
      signUp: async (a) => { window.__signup = a; return { data: { user: { identities: [{}] }, session: null }, error: null }; },
      resend: async (a) => { window.__resend = a; return { error: null }; }
    },
    from: q,
    rpc: async (fn) => ({ data: fn === 'wir_nudge_status' ? (window.__nudgeStatus || { reachable: true, nudged_at: null }) : null, error: null }),
    functions: { invoke: async (name, opts) => {
      window.__invokes.push({ name, body: opts && opts.body });
      const type = opts && opts.body && opts.body.type;
      if (type === 'wrote') return { data: { status: 'sent' }, error: null };
      return { data: window.__nudgeResult || { status: 'sent', nudged_at: new Date().toISOString() }, error: null };
    } },
    storage: { from: () => ({
      createSignedUrl: ok, createSignedUrls: async () => ({ data: [], error: null }), upload: ok, remove: ok,
      download: async (p) => (window.__missingPhotos || []).includes(p)
        ? { data: null, error: { message: 'not found' } }
        : { data: new Blob(['FOTO:' + p], { type: 'image/jpeg' }), error: null }
    }) }
  }; } };
}

export async function launch() {
  try { return await chromium.launch(); }
  catch (e) { return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' }); }
}

// Öffnet die App als angemeldete Person `uid` (oder abgemeldet mit null).
export function makeOpen(browser, url, baseDb) {
  return async function open(uid, { settings = { onboarded: true, design: 2, accent: 'red' }, db = baseDb, query = '', userAgent, welcomeSeen = true, local = {} } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', userAgent, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.route('**cdn.jsdelivr.net**', (r) => {
      const u = r.request().url();
      const body = u.includes('xlsx') ? XLSX_LIB : u.includes('jszip') ? JSZIP_LIB
        : u.includes('supabase') ? `(${browserStub.toString()})(${JSON.stringify(db)});` : '';
      r.fulfill({ status: 200, contentType: 'text/javascript', body });
    });
    await page.addInitScript(([u, st, seen, loc]) => {
      window.__uid = u;
      if (sessionStorage.getItem('__init')) return;   // nur beim ersten Laden vorbereiten, nicht bei Reload
      sessionStorage.setItem('__init', '1');
      localStorage.clear();
      if (u && st) localStorage.setItem('settings_v1_' + u, JSON.stringify(st));
      if (u && seen) localStorage.setItem('wir_welcome_v1_' + u, '1');
      for (const [k, v] of Object.entries(loc)) localStorage.setItem(k, v);
    }, [uid, settings, welcomeSeen, local]);
    await page.goto(url + query, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    return { page, ctx, errors };
  };
}

export function reporter() {
  const results = [];
  return {
    async check(name, fn) {
      try { results.push([name, !!(await fn())]); }
      catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); }
    },
    finish() {
      let bad = 0;
      for (const [n, ok, err] of results) { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (err ? '  [' + err + ']' : '')); }
      console.log(`\n${results.length - bad} von ${results.length} Prüfungen bestanden`);
      return bad;
    }
  };
}
