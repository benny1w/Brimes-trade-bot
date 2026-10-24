const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateSteps, verifyLink } = require('./lib');
const { Platform } = require('./platform');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || __dirname;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 6) {
  console.error('Set ADMIN_PASSWORD (at least 6 characters) in your .env file.');
  process.exit(1);
}

// The address Telegram can reach us on. Render sets RENDER_EXTERNAL_URL by itself.
const publicBase = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const platform = new Platform({
  dataDir: DATA_DIR,
  publicBase,
  secretKey: process.env.SECRET_KEY || ADMIN_PASSWORD,
  templateFile: path.join(__dirname, 'template.json'),
  mainSteps: path.join(__dirname, 'steps.json'),
  mainToken: process.env.BOT_TOKEN, // optional: your original bot, kept as the "main" customer
});

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
const MASTER_HTML = fs.readFileSync(path.join(__dirname, 'public', 'master.html'), 'utf8');

// ---------- small helpers ----------

function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('That is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ---------- login ----------
// Only you can edit. Username "admin" + ADMIN_PASSWORD. Customers have no login at all.

const authCache = new Map(); // remembers good logins for 10 minutes (password hashing is slow on purpose)
const failures = new Map(); // wrong-password counter per visitor, to stop guessing

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';

function authenticate(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return { auth: null };
  const cached = authCache.get(header);
  if (cached && cached.exp > Date.now()) return { auth: cached.auth };

  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.reset > Date.now() && f.n >= 10) return { auth: null, blocked: true };

  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const i = decoded.indexOf(':');
  const user = i < 0 ? '' : decoded.slice(0, i);
  const pass = i < 0 ? '' : decoded.slice(i + 1);

  const auth = user === 'admin' && safeEqual(pass, ADMIN_PASSWORD) ? { role: 'master' } : null;
  if (auth) {
    if (authCache.size > 5000) authCache.clear();
    authCache.set(header, { auth, exp: Date.now() + 10 * 60 * 1000 });
    return { auth };
  }
  const now = Date.now();
  const cur = f && f.reset > now ? f : { n: 0, reset: now + 15 * 60 * 1000 };
  cur.n++;
  failures.set(ip, cur);
  if (failures.size > 10000) failures.clear();
  return { auth: null };
}

// ---------- public routes ----------

// A person taps a link button that also sends a next step: send it, then redirect to the real link.
function handleGo(u, res) {
  const q = u.searchParams;
  const t = platform.getTenant(q.get('t') || '');
  const chatId = q.get('c');
  const stepId = q.get('s');
  const idx = q.get('i');
  if (!t || !chatId || !stepId || idx === null || !verifyLink(t.token, t.id, chatId, stepId, idx, q.get('k'))) {
    return send(res, 403, 'Invalid link', 'text/plain');
  }
  const store = platform.getStore(t.id);
  const button = ((store.loadSteps().steps[stepId] || {}).buttons || [])[Number(idx)];
  if (!button || !button.url) return send(res, 404, 'This link is no longer available', 'text/plain');
  redirect(res, button.url); // redirect straight away so it feels instant
  if (button.then) {
    const bot = platform.bots.get(t.id);
    const saved = store.loadUsers()[chatId] || {};
    if (bot) {
      bot.sendStep(Number(chatId), button.then, { first_name: saved.first_name, last_name: '' }).catch((e) =>
        console.error(`[${t.id}] could not send next step after link:`, e.message)
      );
    }
  }
}

// Telegram posts every message to a customer's bot here
async function handleWebhook(req, res, id) {
  let update;
  try {
    update = await readJson(req, 1_000_000);
  } catch (e) {
    res.writeHead(e.status || 400);
    return res.end();
  }
  const status = platform.handleWebhook(id, req.headers['x-telegram-bot-api-secret-token'], update);
  res.writeHead(status);
  res.end();
}

// ---------- customer editor routes ----------

async function handleCustomer(req, res, auth, id, rest) {
  if (auth.role !== 'master') return send(res, 403, { error: 'Not allowed' });
  const t = platform.getTenant(id);
  if (!t) return send(res, 404, { error: 'Customer not found' });
  if (rest === '') return redirect(res, `/c/${id}/`);
  const store = platform.getStore(id);
  const m = req.method;

  if (m === 'GET' && rest === '/') return send(res, 200, ADMIN_HTML, 'text/html; charset=utf-8');
  if (m === 'GET' && rest === '/api/me') {
    const v = platform.view(t);
    return send(res, 200, { role: auth.role, id, name: v.name, botUsername: v.botUsername, active: v.active, isMain: v.isMain });
  }
  if (m === 'GET' && rest === '/api/steps') return send(res, 200, store.loadSteps());
  if (m === 'PUT' && rest === '/api/steps') {
    const data = await readJson(req, 2_000_000);
    const err = validateSteps(data);
    if (err) return send(res, 400, { error: err });
    store.saveSteps(data);
    return send(res, 200, { ok: true });
  }
  if (m === 'GET' && rest === '/api/stats') {
    return send(res, 200, { users: Object.keys(store.loadUsers()).length, pending: store.pendingCount() });
  }
  if (m === 'GET' && rest === '/api/channel') {
    const st = store.loadSettings();
    return send(res, 200, { channelId: st.channelId || '', posts: store.loadPool().length });
  }
  if (m === 'PUT' && rest === '/api/channel') {
    const body = await readJson(req, 10_000);
    return send(res, 200, await platform.setChannel(id, body.channelId));
  }
  if (m === 'GET' && rest === '/api/users') return send(res, 200, { users: store.listUsers().slice(0, 1000) });
  send(res, 404, { error: 'Not found' });
}

// ---------- master-only routes ----------

async function handleMaster(req, res, p, m) {
  if (p === '/api/tenants' && m === 'GET') {
    return send(res, 200, { tenants: platform.list(), publicBase, mode: publicBase ? 'webhook' : 'polling' });
  }
  if (p === '/api/tenants' && m === 'POST') {
    const body = await readJson(req, 100_000);
    const out = await platform.createTenant(body);
    return send(res, 200, out);
  }
  const tm = p.match(/^\/api\/tenants\/([a-z0-9-]+)$/);
  if (tm && m === 'PATCH') {
    const body = await readJson(req, 100_000);
    const out = await platform.updateTenant(tm[1], body);
    authCache.clear(); // password / pause changes apply immediately
    return send(res, 200, out);
  }
  if (tm && m === 'DELETE') {
    await platform.deleteTenant(tm[1]);
    authCache.clear();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/export' && m === 'GET') {
    const day = new Date().toISOString().slice(0, 10);
    const onlyId = new URL(req.url, 'http://x').searchParams.get('id');
    const data = platform.exportAll(onlyId || undefined);
    // The file name says whose backup it is, e.g. bot-backup-claude-2026-10-23.json
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const file = onlyId
      ? `bot-backup-${slug(data.label) || onlyId}-${day}.json`
      : `bot-backup-ALL-${platform.allTenants().length}-customers-${day}.json`;
    return send(res, 200, JSON.stringify(data), 'application/json', {
      'Content-Disposition': `attachment; filename="${file}"`,
    });
  }
  if (p === '/api/import' && m === 'POST') {
    const body = await readJson(req, 40_000_000);
    const out = await platform.importAll(body);
    authCache.clear();
    return send(res, 200, out);
  }
  send(res, 404, { error: 'Not found' });
}

// ---------- router ----------

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const m = req.method;

  // public: no login (each is protected in its own way)
  if (m === 'GET' && p === '/go') return handleGo(u, res);
  if ((m === 'GET' || m === 'HEAD') && p === '/health') return send(res, 200, 'ok', 'text/plain'); // for uptime monitors
  const wh = p.match(/^\/tg\/([a-z0-9-]+)$/);
  if (m === 'POST' && wh) return handleWebhook(req, res, wh[1]);

  const { auth, blocked } = authenticate(req);
  if (blocked) return send(res, 429, 'Too many wrong logins. Try again in 15 minutes.', 'text/plain');
  if (!auth) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Bot admin"' });
    return res.end('Login required');
  }

  // the old addresses still work and point at your original bot
  if (p === '/admin') return redirect(res, platform.getTenant('main') ? '/c/main/' : '/');
  const rp = p === '/api/steps' || p === '/api/stats' ? '/c/main' + p : p;

  if (m === 'GET' && rp === '/') return send(res, 200, MASTER_HTML, 'text/html; charset=utf-8');
  const c = rp.match(/^\/c\/([a-z0-9-]+)(\/.*)?$/);
  if (c) return handleCustomer(req, res, auth, c[1], c[2] || '');
  if (rp.startsWith('/api/')) {
    if (auth.role !== 'master') return send(res, 403, { error: 'Not allowed' });
    return handleMaster(req, res, rp, m);
  }
  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!e.user && !e.status) console.error('Server error:', e);
    if (res.headersSent) return res.end();
    send(res, e.status || (e.user ? 400 : 500), { error: e.user || e.status ? e.message : 'Something went wrong.' });
  });
});

server.listen(PORT, () => {
  console.log(`Admin: http://localhost:${PORT}/  (username: admin)`);
  console.log(publicBase ? `Telegram updates arrive by webhook at ${publicBase}` : 'No public address set, using polling.');
});
platform.startTicker();
platform.startAll().catch((e) => console.error('Startup error:', e.message));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    platform.flushAll(); // save the user lists before shutting down
    process.exit(0);
  });
}
