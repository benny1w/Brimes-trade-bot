const { fillPlaceholders, buildTrackedUrl, randomGap, followupTexts, pickVariant } = require('./lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UPDATE_TYPES = ['message', 'callback_query'];

// Handle each person's updates one at a time and in order (different people still run in parallel).
// Without this, two quick taps could finish out of order and leave the wrong reminders running.
const chains = new Map();
function enqueue(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error('Update error:', e.message));
  chains.set(key, next);
  next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
}

// One bot per customer. `store` is that customer's own data (steps, users, reminders).
function createBot({ tenant, store, publicBase, webhookSecret }) {
  const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org') + '/bot' + tenant.token;
  const tag = `[${tenant.id}]`;
  let stopped = false;
  let mode = '';
  let username = '';
  let ticking = false;
  const pollAbort = new AbortController();

  async function tg(method, body, attempt = 0) {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: method === 'getUpdates' ? pollAbort.signal : undefined,
    });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`${method} failed: unreadable response (${res.status})`);
    }
    if (!json.ok) {
      // Telegram says "slow down": wait as long as it asks, then try again (up to 3 times)
      if (json.error_code === 429 && attempt < 3) {
        const wait = Math.min(((json.parameters && json.parameters.retry_after) || 1) * 1000, 30000);
        await sleep(wait);
        return tg(method, body, attempt + 1);
      }
      const err = new Error(`${method} failed: ${json.description}`);
      err.description = json.description;
      err.code = json.error_code;
      throw err;
    }
    return json.result;
  }

  function keyboardFor(step, stepId, chatId) {
    const buttons = step.buttons || [];
    if (!buttons.length) return undefined;
    // One button per row, like a menu
    return {
      inline_keyboard: buttons.map((b, idx) => {
        if (!b.url) return [{ text: b.label, callback_data: b.goto }];
        // Link button with a "then" step: route through our server so the next step is sent too
        const tracked = b.then ? buildTrackedUrl(publicBase, tenant.token, tenant.id, chatId, stepId, idx) : null;
        return [{ text: b.label, url: tracked || b.url }];
      }),
    };
  }

  async function deliverStep(chatId, stepId, from) {
    const data = store.loadSteps(); // always the latest, so admin edits go live instantly
    const step = data.steps[stepId];
    if (!step) {
      await tg('sendMessage', { chat_id: chatId, text: 'Sorry, that option is no longer available. Send /start to begin again.' });
      return;
    }
    const text = fillPlaceholders(step.text, from);
    const reply_markup = keyboardFor(step, stepId, chatId);

    if (step.image) {
      const plainLength = text.replace(/<[^>]+>/g, '').length;
      if (plainLength <= 1024) {
        // Short enough: send the picture and the message together as one (caption + buttons)
        try {
          await tg('sendPhoto', { chat_id: chatId, photo: step.image, caption: text, parse_mode: 'HTML', reply_markup });
          return;
        } catch (e) {
          console.error(tag, 'Photo+caption failed, falling back to text only:', e.message);
        }
      } else {
        // Telegram limits captions to 1024 characters, so a long message goes right after the picture
        try {
          await tg('sendPhoto', { chat_id: chatId, photo: step.image });
        } catch (e) {
          console.error(tag, 'Image failed, continuing without it:', e.message);
        }
      }
    }
    try {
      await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup });
    } catch (e) {
      // Bad HTML in the text? Fall back to plain text so the person still gets the message.
      console.error(tag, 'HTML send failed, retrying as plain text:', e.message);
      await tg('sendMessage', { chat_id: chatId, text: text.replace(/<[^>]+>/g, ''), reply_markup });
    }
  }

  async function sendStep(chatId, stepId, from) {
    await deliverStep(chatId, stepId, from);
    // Sending a step cancels the person's old reminders and starts this step's follow-ups (if any)
    try {
      store.planFollowups(chatId, stepId, from);
    } catch (e) {
      console.error(tag, 'Could not plan follow-ups:', e.message);
    }
  }

  async function handleUpdate(update) {
    if (update.message && update.message.text) {
      const msg = update.message;
      store.trackUser(msg.from);
      // /start, /menu or any other text: show the main menu
      await sendStep(msg.chat.id, store.loadSteps().start, msg.from);
    } else if (update.callback_query) {
      const cq = update.callback_query;
      store.trackUser(cq.from);
      try {
        await tg('answerCallbackQuery', { callback_query_id: cq.id }); // stops the button's loading spinner
      } catch (e) {
        console.error(tag, e.message);
      }
      if (cq.message) await sendStep(cq.message.chat.id, cq.data, cq.from);
    }
  }

  // Called for every update, from webhook or polling
  function receive(update) {
    const chatId =
      (update.message && update.message.chat.id) ||
      (update.callback_query && update.callback_query.message && update.callback_query.message.chat.id) ||
      'other';
    enqueue(`${tenant.id}:${chatId}`, () => handleUpdate(update));
  }

  // Sends one follow-up (picking one of its versions at random, never the same as last time).
  // Returns { result: 'sent' | 'gone' | 'drop', idx }: 'gone' = the person blocked the bot or the chat is missing,
  // 'drop' = it can't be sent. Network problems and Telegram overload throw, so it is tried again on the next check.
  async function sendFollowup(chatId, stepId, fi, name, avoid) {
    const step = store.loadSteps().steps[stepId];
    const fu = step && (step.followups || [])[fi];
    if (!fu) return { result: 'drop' }; // step or follow-up was deleted in the admin
    const idx = pickVariant(fu, avoid);
    const text = fillPlaceholders(followupTexts(fu)[idx], { first_name: name });
    const reply_markup = keyboardFor(step, stepId, chatId); // same buttons as the step, so they can continue
    const isGone = (e) => /forbidden|chat not found|deactivated|blocked/i.test(e.description || '');
    const retryLater = (e) => !e.description || e.code === 429 || e.code >= 500;
    try {
      await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup });
      return { result: 'sent', idx };
    } catch (e) {
      if (retryLater(e)) throw e;
      if (isGone(e)) return { result: 'gone' };
      console.error(tag, 'Follow-up HTML send failed, retrying as plain text:', e.message);
    }
    try {
      await tg('sendMessage', { chat_id: chatId, text: text.replace(/<[^>]+>/g, ''), reply_markup });
      return { result: 'sent', idx };
    } catch (e) {
      if (retryLater(e)) throw e;
      console.error(tag, 'Follow-up dropped:', e.message);
      return { result: isGone(e) ? 'gone' : 'drop' };
    }
  }

  async function checkFollowups() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const now = Date.now();
      const jobs = [];
      // At most one follow-up per person per check, so nobody gets a burst of messages
      for (const [chatId, plan] of Object.entries(store.loadSchedule())) {
        const item = plan.items.filter((i) => i.due <= now).sort((a, b) => a.due - b.due)[0];
        if (item) {
          const avoid = plan.last ? plan.last[item.fi] : undefined;
          jobs.push({ chatId, planId: plan.id, stepId: plan.stepId, name: plan.name, item, avoid });
        }
      }
      for (const job of jobs) {
        let out;
        try {
          out = await sendFollowup(Number(job.chatId), job.stepId, job.item.fi, job.name, job.avoid);
        } catch (e) {
          console.error(tag, 'Follow-up will be retried:', e.message);
          continue;
        }
        const fresh = store.loadSchedule(); // re-read: the person may have moved on while we were sending
        const plan = fresh[job.chatId];
        if (plan && plan.id === job.planId) {
          if (out.result === 'gone') {
            delete fresh[job.chatId]; // they blocked the bot: stop everything for them
          } else {
            if (out.result === 'sent') {
              plan.last = plan.last || {};
              plan.last[job.item.fi] = out.idx; // remember which version was used, so the next one differs
            }
            // A "keep repeating" follow-up is scheduled again with a fresh random wait; anything else is finished
            const fu = ((store.loadSteps().steps[job.stepId] || {}).followups || [])[job.item.fi];
            const again = out.result === 'sent' && job.item.loop && fu && fu.forever;
            plan.items = plan.items.filter((i) => !(i.fi === job.item.fi && i.k === job.item.k));
            if (again) plan.items.push({ due: Date.now() + randomGap(fu), fi: job.item.fi, k: job.item.k, loop: true });
            // If the bot was asleep and several reminders are overdue, spread them out instead of sending all at once
            const t = Date.now();
            plan.items.forEach((i) => {
              if (i.due <= t) i.due = t + 30 * 60 * 1000;
            });
            if (!plan.items.length) delete fresh[job.chatId];
          }
          store.saveSchedule(fresh);
        }
        await sleep(40); // about 25 messages a second at most, safely under Telegram's limit
      }
    } catch (e) {
      console.error(tag, 'Follow-up check error:', e.message);
    } finally {
      ticking = false;
    }
  }

  async function pollLoop() {
    let offset = 0;
    while (!stopped) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: UPDATE_TYPES });
        for (const u of updates) {
          offset = u.update_id + 1;
          receive(u);
        }
      } catch (e) {
        if (stopped) break;
        console.error(tag, 'Polling error:', e.message);
        await sleep(3000);
      }
    }
  }

  async function start() {
    const me = await tg('getMe');
    username = me.username || '';
    if (publicBase) {
      // Telegram sends updates to us. Works well with many bots, and wakes a sleeping host.
      mode = 'webhook';
      await tg('setWebhook', {
        url: `${publicBase}/tg/${tenant.id}`,
        secret_token: webhookSecret,
        allowed_updates: UPDATE_TYPES,
      });
    } else {
      // No public address (running on a phone/PC): ask Telegram for updates instead
      mode = 'polling';
      await tg('deleteWebhook').catch(() => {});
      pollLoop();
    }
    console.log(tag, `bot @${username} running (${mode})`);
  }

  // Only for pausing/removing a customer or changing their token, NOT for app shutdown
  async function stop() {
    stopped = true;
    pollAbort.abort();
    if (mode === 'webhook') await tg('deleteWebhook').catch(() => {});
  }

  return {
    start,
    stop,
    receive,
    checkFollowups,
    sendStep,
    get username() {
      return username;
    },
    get mode() {
      return mode;
    },
  };
}

module.exports = { createBot };
