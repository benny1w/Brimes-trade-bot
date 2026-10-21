const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadSteps, saveSteps, validateSteps, loadUsers, verifyLink } = require('./lib');
const { startBot, sendStep } = require('./bot');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 6) {
  console.error('Set ADMIN_PASSWORD (at least 6 characters) in your .env file.');
  process.exit(1);
}

function isAuthed(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Public route (no login): a family member taps a link button. We send them the next step in
// Telegram and redirect them to the real link. Protected by a signature, so it can't be forged.
function handleGo(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const chatId = q.get('c');
  const stepId = q.get('s');
  const idx = q.get('i');
  if (!chatId || !stepId || idx === null || !verifyLink(chatId, stepId, idx, q.get('k'))) {
    res.writeHead(403);
    return res.end('Invalid link');
  }
  const button = ((loadSteps().steps[stepId] || {}).buttons || [])[Number(idx)];
  if (!button || !button.url) {
    res.writeHead(404);
    return res.end('This link is no longer available');
  }
  res.writeHead(302, { Location: button.url }); // redirect straight away so it feels instant
  res.end();
  if (button.then) {
    const saved = loadUsers()[chatId] || {};
    sendStep(Number(chatId), button.then, { first_name: saved.first_name, last_name: '' }).catch((e) =>
      console.error('Could not send next step after link:', e.message)
    );
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.split('?')[0] === '/go') return handleGo(req, res);
  // Public health check for uptime monitors (reveals nothing, just "ok")
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url.split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (!isAuthed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Bot admin"' });
    return res.end('Login required');
  }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/admin')) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url === '/api/steps') {
    return send(res, 200, loadSteps());
  }
  if (req.method === 'GET' && url === '/api/stats') {
    return send(res, 200, { users: Object.keys(loadUsers()).length });
  }
  if (req.method === 'PUT' && url === '/api/steps') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'Invalid JSON.' });
      }
      const err = validateSteps(data);
      if (err) return send(res, 400, { error: err });
      saveSteps(data);
      send(res, 200, { ok: true });
    });
    return;
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Admin page: http://localhost:${PORT}/admin  (username: admin)`));
startBot();
