const express = require('express');
const path = require('path');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3001;
const HOST = '127.0.0.1';              // hanya lokal; akses lewat SSH tunnel
const API = 'https://api.shngm.io/v1';
const HEADERS = {
  accept: 'application/json',
  origin: 'https://11.shinigami.asia',
  referer: 'https://11.shinigami.asia/',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
};
const IMG_HOSTS = new Set(['assets.shngm.id']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- cache sederhana (in-memory) ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  if (cache.size > 500) cache.delete(cache.keys().next().value); // buang yang terlama
  return val;
}

// ---------- antrean request ke upstream: jeda 300ms antar request ----------
let chain = Promise.resolve();
function throttled(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {}).then(() => sleep(100));
  return p;
}
function upstream(p) {
  return throttled(async () => {
    const r = await fetch(API + p, { headers: HEADERS });
    if (!r.ok) {
      const e = new Error(`upstream ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  });
}

// ---------- app ----------
const app = express();

// Redirect /something.html → /something (clean URL)
app.get(/\.html$/, (req, res) => {
  const clean = req.path.replace(/\.html$/, '');
  // /index.html → /
  res.redirect(301, clean === '/index' ? '/' : clean);
});

// Clean URL: serve /browse → browse.html, etc.
const PAGES = ['browse', 'library', 'rankings', 'chapters', 'reader'];
for (const page of PAGES) {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
}

// Root → index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function checkId(req, res, next) {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'id tidak valid' });
  next();
}
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get('/api/manga/:id', checkId, wrap(async (req, res) => {
  const id = req.params.id;
  res.json(await cached(`m:${id}`, 60 * 60 * 1000, () => upstream(`/manga/detail/${id}`)));
}));

// Semua chapter sekaligus (loop halaman kalau total_page > 1)
app.get('/api/manga/:id/chapters', checkId, wrap(async (req, res) => {
  const id = req.params.id;
  const out = await cached(`c:${id}`, 10 * 60 * 1000, async () => {
    const q = (page) => `/chapter/${id}/list?page=${page}&page_size=120&sort_by=chapter_number&sort_order=desc`;
    const first = await upstream(q(1));
    const data = [...first.data];
    const totalPage = first.meta?.total_page ?? 1;
    for (let p = 2; p <= Math.min(totalPage, 20); p++) {   // batas 20 halaman = pengaman
      data.push(...(await upstream(q(p))).data);
    }
    return { data, meta: { total_record: first.meta?.total_record ?? data.length } };
  });
  res.json(out);
}));

app.get('/api/chapter/:id', checkId, wrap(async (req, res) => {
  const id = req.params.id;
  res.json(await cached(`ch:${id}`, 10 * 60 * 1000, () => upstream(`/chapter/detail/${id}`)));
}));

// Proxy gambar (cadangan; CDN sebenarnya tidak butuh Referer)
app.get('/img', wrap(async (req, res) => {
  let u;
  try { u = new URL(String(req.query.url)); } catch { return res.status(400).end(); }
  if (u.protocol !== 'https:' || !IMG_HOSTS.has(u.hostname)) return res.status(403).end();
  const r = await fetch(u, { headers: { referer: HEADERS.referer, 'user-agent': HEADERS['user-agent'] } });
  if (!r.ok) return res.status(r.status).end();
  res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  Readable.fromWeb(r.body).pipe(res);
}));

// Static files (harus setelah API routes agar /api/* tidak tershadow)
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 502).json({ error: err.message });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`Server jalan di http://${HOST}:${PORT}`));
}

module.exports = app;
