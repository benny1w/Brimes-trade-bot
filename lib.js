const fs = require('fs');
const path = require('path');

const STEPS_FILE = path.join(__dirname, 'steps.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const ID_RE = /^[a-z0-9_-]{1,40}$/;

function loadSteps() {
  return JSON.parse(fs.readFileSync(STEPS_FILE, 'utf8'));
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
    if (typeof step.text !== 'string' || !step.text.trim()) return `Step "${id}" needs some text.`;
    if (step.text.length > 4000) return `Step "${id}" text is too long (max 4000 characters).`;
    const buttons = step.buttons || [];
    if (!Array.isArray(buttons)) return `Step "${id}" has invalid buttons.`;
    if (buttons.length > 20) return `Step "${id}" has too many buttons (max 20).`;
    for (const b of buttons) {
      if (!b || typeof b.label !== 'string' || !b.label.trim()) return `A button in "${id}" has no label.`;
      if (b.url) {
        if (!/^https?:\/\//i.test(b.url)) return `Button "${b.label}" in "${id}": link must start with http:// or https://`;
      } else if (!b.goto || !data.steps[b.goto]) {
        return `Button "${b.label}" in "${id}" points to a step that doesn't exist.`;
      }
    }
  }
  return null;
}

function saveSteps(data) {
  const clean = { start: data.start, steps: {} };
  for (const [id, s] of Object.entries(data.steps)) {
    clean.steps[id] = {
      text: s.text,
      image: s.image || '',
      buttons: (s.buttons || []).map((b) =>
        b.url ? { label: b.label, url: b.url } : { label: b.label, goto: b.goto }
      ),
    };
  }
  const tmp = STEPS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, STEPS_FILE); // atomic, so the bot never reads a half-written file
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function trackUser(from) {
  if (!from) return;
  const users = loadUsers();
  users[from.id] = {
    first_name: from.first_name || '',
    username: from.username || '',
    last_seen: new Date().toISOString(),
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

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

module.exports = { loadSteps, saveSteps, validateSteps, loadUsers, trackUser, fillPlaceholders, escapeHtml };
