const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore, writeJsonAtomic, validateSteps } = require('./lib');
const { createBot } = require('./bot');

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// An error whose message is safe to show to the person using the admin page
function userError(message) {
  const e = new Error(message);
  e.user = true;
  return e;
}

async function telegramGetMe(token) {
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  let json;
  try {
    const res = await fetch(`${base}/bot${token}/getMe`);
    json = await res.json();
  } catch {
    throw userError('Could not reach Telegram to check that token. Try again in a moment.');
  }
  if (!json.ok) throw userError('Telegram rejected that bot token. Copy it again from BotFather.');
  return json.result;
}

// Runs every customer's bot and keeps the list of customers.
class Platform {
  constructor({ dataDir, publicBase, secretKey, templateFile, mainSteps, mainToken }) {
    this.dataDir = dataDir;
    this.publicBase = publicBase || '';
    this.secretKey = secretKey;
    this.templateFile = templateFile;
    this.mainSteps = mainSteps;
    this.mainToken = mainToken || '';
    this.file = path.join(dataDir, 'tenants.json');
    this.tenants = {}; // customers added in the admin (the "main" bot comes from the environment)
    this.stores = new Map();
    this.bots = new Map();
    this.loadRegistry();
  }

  loadRegistry() {
    try {
      this.tenants = JSON.parse(fs.readFileSync(this.file, 'utf8')).tenants || {};
    } catch {
      this.tenants = {};
    }
  }

  saveRegistry() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    writeJsonAtomic(this.file, { tenants: this.tenants });
  }

  dirFor(id) {
    return id === 'main' ? this.dataDir : path.join(this.dataDir, 'tenants', id);
  }

  mainTenant() {
    if (!this.mainToken) return null;
    return { id: 'main', name: process.env.MAIN_NAME || 'Main bot', token: this.mainToken, active: true, isMain: true, botUsername: '', createdAt: 0 };
  }

  getTenant(id) {
    return id === 'main' ? this.mainTenant() : this.tenants[id] || null;
  }

  allTenants() {
    const m = this.mainTenant();
    return [...(m ? [m] : []), ...Object.values(this.tenants)];
  }

  getStore(id) {
    let s = this.stores.get(id);
    if (!s) {
      s = createStore(this.dirFor(id), id === 'main' ? this.mainSteps : this.templateFile);
      this.stores.set(id, s);
    }
    return s;
  }

  webhookSecret(id) {
    return crypto.createHmac('sha256', this.secretKey).update('wh|' + id).digest('hex').slice(0, 40);
  }

  view(t) {
    const store = this.getStore(t.id);
    const bot = this.bots.get(t.id);
    return {
      id: t.id,
      name: t.name,
      active: t.active !== false,
      isMain: !!t.isMain,
      botUsername: (bot && bot.username) || t.botUsername || '',
      users: Object.keys(store.loadUsers()).length,
      pending: store.pendingCount(),
      createdAt: t.createdAt || 0,
    };
  }

  list() {
    return this.allTenants().map((t) => this.view(t));
  }

  // ----- running the bots -----

  async startBot(id) {
    const t = this.getTenant(id);
    if (!t || t.active === false) return;
    await this.stopBot(id);
    const bot = createBot({
      tenant: t,
      store: this.getStore(id),
      publicBase: this.publicBase,
      webhookSecret: this.webhookSecret(id),
    });
    this.bots.set(id, bot);
    try {
      await bot.start();
      if (t.id !== 'main' && bot.username && t.botUsername !== bot.username) {
        t.botUsername = bot.username;
        this.saveRegistry();
      }
    } catch (e) {
      console.error(`[${id}] could not start:`, e.message);
    }
  }

  async stopBot(id) {
    const bot = this.bots.get(id);
    if (!bot) return;
    this.bots.delete(id);
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
  }

  async startAll() {
    const ids = this.allTenants().filter((t) => t.active !== false).map((t) => t.id);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) await this.startBot(ids[next++]);
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]); // 5 at a time
  }

  startTicker() {
    const every = Number(process.env.TICK_MS) || 30000;
    this.ticker = setInterval(() => {
      for (const bot of this.bots.values()) bot.checkFollowups();
    }, every);
  }

  flushAll() {
    for (const s of this.stores.values()) s.flush();
  }

  // Telegram calls this for every message to a customer's bot (webhook mode)
  handleWebhook(id, secret, update) {
    const t = this.getTenant(id);
    if (!t) return 404;
    const expected = Buffer.from(this.webhookSecret(id));
    const got = Buffer.from(String(secret || ''));
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return 403;
    const bot = this.bots.get(id);
    if (bot && update && typeof update === 'object') bot.receive(update); // paused customers are ignored
    return 200;
  }

  // ----- managing customers (master admin) -----

  async createTenant({ name, id, token }) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw userError('Customer name is required.');
    token = String(token || '').trim();
    if (!TOKEN_RE.test(token)) throw userError('That does not look like a bot token. It should look like 123456789:AAH...');
    if (this.allTenants().some((t) => t.token === token)) throw userError('That bot token is already used by another customer.');

    if (id && String(id).trim()) {
      id = String(id).trim().toLowerCase();
      if (!TENANT_ID_RE.test(id)) throw userError('Customer ID: use 2-31 lowercase letters, numbers or dashes.');
      if (id === 'main' || this.tenants[id]) throw userError('That customer ID is already taken.');
    } else {
      const base = slug(name) || 'customer';
      id = base.length >= 2 ? base : base + '-1';
      for (let n = 2; id === 'main' || this.tenants[id]; n++) id = `${base.slice(0, 26)}-${n}`;
    }

    const me = await telegramGetMe(token);
    this.tenants[id] = {
      id,
      name,
      token,
      active: true,
      botUsername: me.username || '',
      createdAt: Date.now(),
    };
    this.saveRegistry();
    this.getStore(id).loadSteps(); // creates their starter steps
    await this.startBot(id);
    return { tenant: this.view(this.tenants[id]) };
  }

  async updateTenant(id, patch) {
    const t = this.tenants[id];
    if (!t) throw userError(id === 'main' ? 'The main bot is controlled by the server settings.' : 'Customer not found.');
    let restart = false;

    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 60);
      if (!name) throw userError('Name cannot be empty.');
      t.name = name;
    }
    if (patch.token !== undefined) {
      const token = String(patch.token).trim();
      if (!TOKEN_RE.test(token)) throw userError('That does not look like a bot token.');
      if (this.allTenants().some((o) => o.token === token && o.id !== id)) throw userError('That bot token is already used by another customer.');
      const me = await telegramGetMe(token);
      await this.stopBot(id); // removes the old bot's webhook with the old token
      t.token = token;
      t.botUsername = me.username || '';
      restart = true;
    }
    if (patch.active !== undefined) {
      const active = !!patch.active;
      if (active !== (t.active !== false)) {
        t.active = active;
        restart = true;
        if (!active) await this.stopBot(id);
      }
    }
    this.saveRegistry();
    if (restart && t.active !== false) await this.startBot(id);
    return { tenant: this.view(t) };
  }

  async deleteTenant(id) {
    const t = this.tenants[id];
    if (!t) throw userError(id === 'main' ? 'The main bot is controlled by the server settings.' : 'Customer not found.');
    await this.stopBot(id);
    delete this.tenants[id];
    this.stores.delete(id);
    this.saveRegistry();
    // Keep their files aside rather than erasing them straight away
    const dir = this.dirFor(id);
    if (fs.existsSync(dir)) {
      try {
        fs.renameSync(dir, path.join(this.dataDir, 'tenants', `_deleted_${id}_${Date.now()}`));
      } catch (e) {
        console.error('Could not move deleted customer files:', e.message);
      }
    }
  }

  // ----- backup and restore (important on free hosting, where files can reset) -----

  // Everything, or just one customer when onlyId is given
  exportAll(onlyId) {
    const list = onlyId ? [this.getTenant(onlyId)].filter(Boolean) : this.allTenants();
    if (onlyId && !list.length) throw userError('Customer not found.');
    const data = {};
    for (const t of list) {
      const s = this.getStore(t.id);
      s.flush();
      data[t.id] = { steps: s.loadSteps(), users: s.loadUsers(), schedule: s.loadSchedule() };
    }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      label: onlyId ? list[0].name : 'All customers',
      tenants: list.filter((t) => !t.isMain),
      data,
    };
  }

  async importAll(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.tenants) || typeof obj.data !== 'object' || !obj.data) {
      throw userError('That does not look like a backup file from this system.');
    }
    // Check everything first so a bad file changes nothing
    for (const t of obj.tenants) {
      if (!t || !TENANT_ID_RE.test(t.id || '') || t.id === 'main') throw userError(`Backup has an invalid customer ID: ${t && t.id}`);
      if (!TOKEN_RE.test(t.token || '')) throw userError(`Backup has an invalid token for "${t.id}".`);
      if (typeof t.name !== 'string' || !t.name.trim()) throw userError(`Backup has a customer without a name: "${t.id}".`);
    }
    for (const [id, d] of Object.entries(obj.data)) {
      if (id !== 'main' && !TENANT_ID_RE.test(id)) throw userError(`Backup has an invalid data ID: ${id}`);
      if (id === 'main' && !this.mainTenant()) continue;
      if (id !== 'main' && !obj.tenants.some((t) => t.id === id)) continue;
      const err = d && d.steps ? validateSteps(d.steps) : null;
      if (err) throw userError(`Backup data for "${id}" is invalid: ${err}`);
    }
    let customers = 0;
    for (const t of obj.tenants) {
      const old = this.tenants[t.id];
      if (old && old.token !== t.token) await this.stopBot(t.id);
      this.tenants[t.id] = {
        id: t.id,
        name: t.name.trim().slice(0, 60),
        token: t.token,
        active: t.active !== false,
        botUsername: t.botUsername || '',
        createdAt: t.createdAt || Date.now(),
      };
      customers++;
    }
    this.saveRegistry();
    for (const [id, d] of Object.entries(obj.data)) {
      if (id === 'main' ? !this.mainTenant() : !this.tenants[id]) continue;
      this.getStore(id).replaceAll(d || {});
    }
    for (const t of obj.tenants) await this.startBot(t.id);
    if (obj.data.main && this.mainTenant()) await this.startBot('main');
    return { customers };
  }
}

module.exports = { Platform, userError };
