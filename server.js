const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadSteps, saveSteps, validateSteps, loadUsers } = require('./lib');
const { startBot } = require('./bot');

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

const server = http.createServer((req, res) => {
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
