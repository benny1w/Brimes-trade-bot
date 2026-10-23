const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9_-]{1,40}$/;
const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };

// ---------- Steps: validation and cleaning ----------

// Returns an error string, or null if the data is valid.
function validateSteps(data) {
  if (!data || typeof data !== 'object' || typeof data.steps !== 'object' || data.steps === null) {
    return 'Invalid data format.';
  }
  const ids = Object.keys(data.steps);
  if (ids.length === 0) return 'You need at least one step.';
  if (!data.start || !data.steps[data.start]) return 'The start step must exist.';
  for (const id of ids) {
    if (!ID_RE.test(id)) {
      return `Step ID "${id}" is invalid. Use only lowercase letters, numbers, - and _ (max 40).`;
    }
    const step = data.steps[id];
    if (!step || typeof step.text !== 'string' || !step.text.trim()) return `Step "${id}" needs some text.`;
    if (step.text.length > 4000) return `Step "${id}" text is too long (max 4000 characters).`;
    const buttons = step.buttons || [];
    if (!Array.isArray(buttons)) return `Step "${id}" has invalid buttons.`;
    if (buttons.length > 20) return `Step "${id}" has too many buttons (max 20).`;
    for (const b of buttons) {
      if (!b || typeof b.label !== 'string' || !b.label.trim()) return `A button in "${id}" has no label.`;
      if (b.url) {
        if (!/^https?:\/\//i.test(b.url)) return `Button "${b.label}" in "${id}": link must start with http:// or https://`;
        if (b.then && !data.steps[b.then]) return `Button "${b.label}" in "${id}" has a "then show" step that doesn't exist.`;
      } else if (!b.goto || !data.steps[b.goto]) {
        return `Button "${b.label}" in "${id}" points to a step that doesn't exist.`;
      }
    }
    const fus = step.followups || [];
    if (!Array.isArray(fus)) return `Step "${id}" has invalid follow-ups.`;
    if (fus.length > 10) return `Step "${id}" has too many follow-ups (max 10).`;
    for (const f of fus) {
      if (!f || typeof f.text !== 'string' || !f.text.trim()) return `A follow-up in "${id}" needs some message text.`;
      if (f.text.length > 4000) return `A follow-up in "${id}" is too long (max 4000 characters).`;
      if (!UNIT_MS[f.unit]) return `A follow-up in "${id}" has an invalid time unit.`;
      if (!(Number(f.after) > 0)) return `A follow-up in "${id}" needs a time greater than 0.`;
      const rep = Number(f.repeat || 0);
      if (!Number.isInteger(rep) || rep < 0 || rep > 20) return `A follow-up in "${id}": "repeat" must be a whole number from 0 to 20.`;
    }
  }
  return null;
}

// Keeps only known fields, so nothing unexpected gets saved.
function cleanSteps(data) {
  const clean = { start: data.start, steps: {} };
  for (const [id, s] of Object.entries(data.steps)) {
    clean.steps[id] = {
      text: s.text,
      image: s.image || '',
      buttons: (s.buttons || []).map((b) => {
        if (!b.url) return { label: b.label, goto: b.goto };
        const out = { label: b.label, url: b.url };
        if (b.then) out.then = b.then;
        return out;
      }),
    };
    const fus = s.followups || [];
    if (fus.length) {
      clean.steps[id].followups = fus.map((f) => ({
        text: f.text,
        after: Number(f.after),
        unit: f.unit,
        repeat: Number(f.repeat || 0),
      }));
    }
  }
  return clean;
}

// ---------- Text helpers ----------

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fillPlaceholders(text, from) {
  const first = escapeHtml((from && from.first_name) || 'friend');
  const last = escapeHtml((from && from.last_name) || '');
  const full = [first, last].filter(Boolean).join(' ');
  return text
    .replace(/\{first_name\}/g, first)
    .replace(/\{name\}/g, first)
    .replace(/\{full_name\}/g, full);
}

// ---------- "Open link, then also show next step" links ----------
// A link button with a "then" step points at our own server (/go). The server sends the next step
// to that person's chat and redirects them to the real link. The signature (made with that
// customer's own bot token) stops anyone forging links for other people's chats.

function signLink(token, tenantId, chatId, stepId, idx) {
  return crypto
    .createHmac('sha256', token || '')
    .update(`${tenantId}|${chatId}|${stepId}|${idx}`)
    .digest('hex')
    .slice(0, 24);
}

function verifyLink(token, tenantId, chatId, stepId, idx, sig) {
  const a = Buffer.from(signLink(token, tenantId, chatId, stepId, idx));
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function buildTrackedUrl(base, token, tenantId, chatId, stepId, idx) {
  if (!base) return null;
  const q = new URLSearchParams({
    t: tenantId,
    c: String(chatId),
    s: stepId,
    i: String(idx),
    k: signLink(token, tenantId, chatId, stepId, idx),
  });
  return `${base}/go?${q.toString()}`;
}

// ---------- Files ----------

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic, so nobody ever reads a half-written file
}

// ---------- One store per customer ----------
// Everything lives in memory after the first read (fast with many customers) and is written to
// disk whenever it changes. Steps and reminders are written immediately; the user list is
// written a few seconds later in one go, so a busy bot doesn't rewrite the file on every message.

function createStore(dir, templateFile) {
  const files = {
    steps: path.join(dir, 'steps.json'),
    users: path.join(dir, 'users.json'),
    schedule: path.join(dir, 'schedule.json'),
  };
  let steps = null;
  let users = null;
  let schedule = null;
  let usersDirty = false;
  let usersTimer = null;

  const ensureDir = () => fs.mkdirSync(dir, { recursive: true });
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };

  const store = {
    dir,

    loadSteps() {
      if (!steps) {
        ensureDir();
        if (!fs.existsSync(files.steps)) fs.copyFileSync(templateFile, files.steps); // first run: starter steps
        steps = JSON.parse(fs.readFileSync(files.steps, 'utf8'));
      }
      return steps;
    },

    saveSteps(data) {
      const clean = cleanSteps(data);
      ensureDir();
      writeJsonAtomic(files.steps, clean);
      steps = clean;
    },

    loadUsers() {
      if (!users) users = readJson(files.users, {});
      return users;
    },

    trackUser(from) {
      if (!from) return;
      store.loadUsers()[from.id] = {
        first_name: from.first_name || '',
        username: from.username || '',
        last_seen: new Date().toISOString(),
      };
      usersDirty = true;
      if (!usersTimer) {
        usersTimer = setTimeout(() => {
          usersTimer = null;
          store.flush();
        }, 3000);
        if (usersTimer.unref) usersTimer.unref();
      }
    },

    flush() {
      if (!usersDirty) return;
      try {
        ensureDir();
        writeJsonAtomic(files.users, users);
        usersDirty = false;
      } catch (e) {
        console.error('Could not save users:', e.message);
      }
    },

    loadSchedule() {
      if (!schedule) schedule = readJson(files.schedule, {});
      return schedule;
    },

    saveSchedule(s) {
      schedule = s;
      ensureDir();
      writeJsonAtomic(files.schedule, s);
    },

    pendingCount() {
      return Object.values(store.loadSchedule()).reduce((n, p) => n + p.items.length, 0);
    },

    // Every time a step is sent to someone, their pending reminders are replaced with that step's
    // follow-ups. So the moment they tap a button that moves them on, old reminders are cancelled.
    planFollowups(chatId, stepId, from) {
      const step = store.loadSteps().steps[stepId];
      const fus = (step && step.followups) || [];
      const sched = store.loadSchedule();
      const now = Date.now();
      const items = [];
      fus.forEach((f, fi) => {
        const gap = Number(f.after) * UNIT_MS[f.unit];
        for (let k = 0; k <= Number(f.repeat || 0); k++) items.push({ due: now + gap * (k + 1), fi, k });
      });
      if (!items.length) {
        if (!(chatId in sched)) return; // nothing to cancel, nothing to add
        delete sched[chatId];
      } else {
        sched[chatId] = {
          id: now + '-' + Math.random().toString(36).slice(2, 8),
          stepId,
          name: (from && from.first_name) || '',
          items,
        };
      }
      store.saveSchedule(sched);
    },

    // Used by "Restore backup"
    replaceAll(d) {
      if (d.steps) store.saveSteps(d.steps);
      if (d.users && typeof d.users === 'object') {
        users = d.users;
        usersDirty = true;
        store.flush();
      }
      if (d.schedule && typeof d.schedule === 'object') store.saveSchedule(d.schedule);
    },
  };
  return store;
}

module.exports = {
  ID_RE, UNIT_MS,
  validateSteps, cleanSteps, escapeHtml, fillPlaceholders,
  signLink, verifyLink, buildTrackedUrl,
  writeJsonAtomic, createStore,
};
