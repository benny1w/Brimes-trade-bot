const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9_-]{1,40}$/;
const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
// A follow-up that repeats forever must wait at least this long between messages, so nobody gets spammed
// (and the bot doesn't get reported). Can be lowered with MIN_LOOP_MINUTES, only useful for testing.
const MIN_LOOP_MS = (process.env.MIN_LOOP_MINUTES !== undefined ? Number(process.env.MIN_LOOP_MINUTES) : 5) * 60 * 1000;

// ---------- Follow-up helpers ----------

// How long to wait: a fixed time, or a random time between "after" and "afterMax"
function randomGap(f) {
  const lo = Number(f.after) * UNIT_MS[f.unit];
  const hi = Number(f.afterMax) > Number(f.after) ? Number(f.afterMax) * UNIT_MS[f.unit] : lo;
  return lo + Math.random() * (hi - lo);
}

// All versions of the message (the main text plus any extra versions)
function followupTexts(f) {
  return [f.text, ...(f.variants || []).filter((v) => typeof v === 'string' && v.trim())];
}

// Picks one version at random, never the same one twice in a row
function pickVariant(f, avoid) {
  const n = followupTexts(f).length;
  if (n <= 1) return 0;
  let idx = Math.floor(Math.random() * n);
  if (idx === avoid) idx = (idx + 1 + Math.floor(Math.random() * (n - 1))) % n;
  return idx;
}

// ---------- Steps: validation and cleaning ----------

function checkFollowupList(list, where, data) {
  const fus = list || [];
  if (!Array.isArray(fus)) return `Invalid follow-ups in ${where}.`;
  if (fus.length > 10) return `Too many follow-ups in ${where} (max 10).`;
    for (const f of fus) {
      if (!f || typeof f !== 'object') return `A follow-up in ${where} is invalid.`;
      if (f.channel) {
        if (f.text !== undefined && typeof f.text !== 'string') return `A follow-up in ${where} has invalid text.`;
      } else if (typeof f.text !== 'string' || !f.text.trim()) return `A follow-up in ${where} needs some message text.`;
      if (String(f.text || '').length > 4000) return `A follow-up in ${where} is too long (max 4000 characters).`;
      if (!UNIT_MS[f.unit]) return `A follow-up in ${where} has an invalid time unit.`;
      if (!(Number(f.after) > 0)) return `A follow-up in ${where} needs a time greater than 0.`;
      const rep = Number(f.repeat || 0);
      if (!Number.isInteger(rep) || rep < 0 || rep > 20) return `A follow-up in ${where}: "repeat" must be a whole number from 0 to 20.`;
      if (f.afterMax !== undefined && f.afterMax !== '' && f.afterMax !== null) {
        if (!(Number(f.afterMax) > 0)) return `A follow-up in ${where}: the second ("to") time must be greater than 0.`;
        if (Number(f.afterMax) < Number(f.after)) return `A follow-up in ${where}: the second ("to") time must be bigger than the first, or leave it empty.`;
      }
      if (f.buttons !== undefined) {
        if (!Array.isArray(f.buttons) || f.buttons.length > 10) return `A follow-up in ${where} can have at most 10 buttons.`;
        for (const b of f.buttons) {
          if (!b || typeof b.label !== 'string' || !b.label.trim()) return `A button in a follow-up in ${where} has no label.`;
          if (b.url) {
            if (!/^https?:\/\//i.test(b.url)) return `Button "${b.label}" in a follow-up in ${where}: link must start with http:// or https://`;
            if (b.then && !(data && data.steps && data.steps[b.then])) return `Button "${b.label}" in a follow-up in ${where} has a "then send" step that doesn't exist.`;
          } else if (!b.goto || !(data && data.steps && data.steps[b.goto])) {
            return `Button "${b.label}" in a follow-up in ${where} points to a step that doesn't exist.`;
          }
        }
      }
      for (const k of ['image', 'video']) {
        if (f[k] && !/^https?:\/\//i.test(String(f[k]).trim())) return `A follow-up in ${where}: the ${k} link must start with http:// or https://`;
      }
      if (f.variants !== undefined) {
        if (!Array.isArray(f.variants) || f.variants.length > 10) return `A follow-up in ${where} can have at most 10 extra versions.`;
        for (const v of f.variants) {
          if (typeof v !== 'string') return `A follow-up in ${where} has an invalid extra version.`;
          if (v.length > 4000) return `An extra version in ${where} is too long (max 4000 characters).`;
        }
      }
      if (f.forever && Number(f.after) * UNIT_MS[f.unit] < MIN_LOOP_MS) {
        return `A follow-up in ${where} that repeats forever must wait at least ${Math.round(MIN_LOOP_MS / 60000)} minutes between messages.`;
      }
    }
  return null;
}

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
    const e1 = checkFollowupList(step.followups, `"${id}"`, data);
    if (e1) return e1;
  }
  const e2 = checkFollowupList(data.followups, 'the general follow-ups', data);
  if (e2) return e2;
  return null;
}

function cleanFollowupList(list) {
  return (list || []).map((f) => {
    const out = { text: f.text || '', after: Number(f.after), unit: f.unit, repeat: Number(f.repeat || 0) };
    if (f.channel) out.channel = true; // the message is taken from the customer's Telegram channel
    if (Number(f.afterMax) > Number(f.after)) out.afterMax = Number(f.afterMax); // random wait between the two
    const variants = (f.variants || []).filter((v) => typeof v === 'string' && v.trim());
    if (variants.length) out.variants = variants;
    if (f.forever) out.forever = true;
    if (f.image && String(f.image).trim()) out.image = String(f.image).trim();
    if (f.video && String(f.video).trim()) out.video = String(f.video).trim();
    const btns = (f.buttons || []).map((b) => {
      if (!b.url) return { label: b.label, goto: b.goto };
      const o = { label: b.label, url: b.url };
      if (b.then) {
        o.then = b.then;
        const m = Number(b.thenAfter);
        o.thenAfter = m > 0 && m <= 1440 ? m : 1; // minutes after the reminder before the next step is sent
      }
      return o;
    });
    if (btns.length) out.buttons = btns; // this follow-up's own buttons (otherwise the step's buttons are used)
    return out;
  });
}

// Which reminders apply to a step: its own, or none, or the general ones that apply to every step
// The list has a `random` flag: when true, the follow-ups are alternatives (one is picked at random each time)
function followupsFor(data, stepId) {
  const step = data && data.steps && data.steps[stepId];
  if (!step) return [];
  let list, random;
  if (step.followups && step.followups.length) { list = step.followups; random = step.followupsRandom; }
  else if (step.noFollowups) { list = []; random = false; }
  else { list = data.followups || []; random = data.followupsRandom; }
  return Object.assign(list.slice(), { random: !!random });
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
        if (b.then) {
          out.then = b.then;
          const m = Number(b.thenAfter);
          out.thenAfter = m > 0 && m <= 1440 ? m : 1; // minutes to wait before sending the next step
        }
        return out;
      }),
    };
    const own = cleanFollowupList(s.followups);
    if (own.length) {
      clean.steps[id].followups = own;
      if (s.followupsRandom && own.length > 1) clean.steps[id].followupsRandom = true;
    }
    else if (s.noFollowups) clean.steps[id].noFollowups = true; // this step sends no reminders at all
  }
  const general = cleanFollowupList(data.followups);
  if (general.length) clean.followups = general;
  if (general.length > 1 && data.followupsRandom) clean.followupsRandom = true;
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
    settings: path.join(dir, 'settings.json'),
    pool: path.join(dir, 'pool.json'),
  };
  let settings = null;
  let pool = null;
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

    trackUser(from, via) {
      if (!from) return;
      const all = store.loadUsers();
      const old = all[from.id] || {};
      const now = new Date().toISOString();
      all[from.id] = {
        first_name: from.first_name || '',
        username: from.username || '',
        first_seen: old.first_seen || now,
        last_seen: now,
        via: old.via || via || 'bot', // how they first reached you: 'bot' (messaged it) or 'channel' (asked to join)
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

    // The people list for the admin page (newest first)
    listUsers() {
      return Object.entries(store.loadUsers())
        .map(([id, u]) => ({ id, ...u }))
        .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
    },

    // Settings that belong to this customer's bot (for now: the channel their reminder messages come from)
    loadSettings() {
      if (!settings) settings = readJson(files.settings, {});
      return settings;
    },

    saveSettings(patch) {
      settings = { ...store.loadSettings(), ...patch };
      ensureDir();
      writeJsonAtomic(files.settings, settings);
    },

    // Message numbers of the posts the bot has seen in the customer's channel
    loadPool() {
      if (!pool) {
        const p = readJson(files.pool, []);
        pool = Array.isArray(p) ? p.filter((n) => Number.isInteger(n)) : [];
      }
      return pool;
    },

    savePool(list) {
      pool = list;
      ensureDir();
      writeJsonAtomic(files.pool, pool);
    },

    addPost(messageId) {
      const p = store.loadPool();
      if (p.includes(messageId)) return;
      p.push(messageId);
      if (p.length > 500) p.splice(0, p.length - 500); // keep the newest 500
      store.savePool(p);
    },

    removePost(messageId) {
      store.savePool(store.loadPool().filter((n) => n !== messageId));
    },

    pendingCount() {
      return Object.values(store.loadSchedule()).reduce((n, p) => n + p.items.length, 0);
    },

    // Every time a step is sent to someone, their pending reminders are replaced with that step's
    // follow-ups. So the moment they tap a button that moves them on, old reminders are cancelled.
    planFollowups(chatId, stepId, from) {
      const all = store.loadSteps();
      const step = all.steps[stepId];
      let fus = followupsFor(all, stepId);
      if (fus.random && fus.length > 1) fus = [fus[0]]; // random mode: one schedule (the first one's timing), a random message each time
      const sched = store.loadSchedule();
      const now = Date.now();
      const items = [];
      // Link buttons with a "then" step: the real link is shown as-is, and the next step follows by itself after a short wait
      ((step && step.buttons) || []).forEach((b, bi) => {
        if (b.url && b.then) items.push({ due: now + (Number(b.thenAfter) > 0 ? Number(b.thenAfter) : 1) * 60 * 1000, step: b.then, fi: -1 - bi, k: 0 });
      });
      fus.forEach((f, fi) => {
        if (f.forever) {
          // One "loop" item: after each send it is scheduled again, until the person moves on
          items.push({ due: now + randomGap(f), fi, k: 0, loop: true });
          return;
        }
        let t = now;
        for (let k = 0; k <= Number(f.repeat || 0); k++) {
          t += randomGap(f);
          items.push({ due: t, fi, k });
        }
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
      if (d.settings && typeof d.settings === 'object') store.saveSettings({ channelId: String(d.settings.channelId || '') });
      if (Array.isArray(d.pool)) store.savePool(d.pool.filter((n) => Number.isInteger(n)).slice(-500));
    },
  };
  return store;
}

module.exports = {
  ID_RE, UNIT_MS, followupsFor, randomGap, followupTexts, pickVariant,
  validateSteps, cleanSteps, escapeHtml, fillPlaceholders,
  signLink, verifyLink, buildTrackedUrl,
  writeJsonAtomic, createStore,
};
