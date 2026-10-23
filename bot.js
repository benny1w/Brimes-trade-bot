const { fillPlaceholders, buildTrackedUrl, followupsFor, randomGap, followupTexts, pickVariant } = require('./lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UPDATE_TYPES = ['message', 'callback_query', 'chat_join_request'];

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
        return [{ text: b.label, url: b.url }]; // exactly the link you typed, nothing added
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

  // Someone asked to join a channel/group this bot manages: accept them, then message them straight away.
  // (Needs the bot to be an admin with "invite users" and the invite link set to "request admin approval".)
  async function handleJoinRequest(req) {
    const user = req.from;
    store.trackUser(user, 'channel');
    try {
      await tg('approveChatJoinRequest', { chat_id: req.chat.id, user_id: user.id });
      console.log(tag, `accepted ${user.id} into ${req.chat.title || req.chat.id}`);
    } catch (e) {
      // Already accepted / request expired is fine; anything else (e.g. bot is not an admin) means we can't help
      if (!/already|HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT/i.test(e.description || '')) {
        console.error(tag, 'Could not accept join request:', e.message);
        return;
      }
    }
    // The request gives the bot a direct line to the person (valid for a few minutes), even if they never opened the bot
    await sendStep(req.user_chat_id || user.id, store.loadSteps().start, user);
  }

  async function handleUpdate(update) {
    if (update.chat_join_request) {
      await handleJoinRequest(update.chat_join_request);
    } else if (update.message && update.message.text) {
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
      (update.chat_join_request && (update.chat_join_request.user_chat_id || update.chat_join_request.from.id)) ||
      (update.message && update.message.chat.id) ||
      (update.callback_query && update.callback_query.message && update.callback_query.message.chat.id) ||
      'other';
    enqueue(`${tenant.id}:${chatId}`, () => handleUpdate(update));
  }

  // Sends one follow-up (picking one of its versions at random, never the same as last time).
  // Returns { result: 'sent' | 'gone' | 'drop', idx }: 'gone' = the person blocked the bot or the chat is missing,
  // 'drop' = it can't be sent. Network problems and Telegram overload throw, so it is tried again on the next check.
  async function sendFollowup(chatId, stepId, fi, name, avoid, prevIds) {
    const all = store.loadSteps();
    const step = all.steps[stepId];
    const fu = step && followupsFor(all, stepId)[fi];
    if (!fu) return { result: 'drop' }; // step or follow-up was deleted in the admin
    const idx = pickVariant(fu, avoid);
    // Take the previous reminder out of their chat first, so reminders don't pile up (Telegram allows this for 48 hours)
    for (const mid of prevIds || []) {
      try {
        await tg('deleteMessage', { chat_id: chatId, message_id: mid });
      } catch (e) {
        if (!e.description) throw e; // network trouble: try the whole thing again on the next check
        // already deleted by them, or too old: nothing to do
      }
    }
    const ids = [];
    const keep = (r) => { if (r && r.message_id) ids.push(r.message_id); };
    const text = fillPlaceholders(followupTexts(fu)[idx], { first_name: name });
    const reply_markup = keyboardFor(step, stepId, chatId); // same buttons as the step, so they can continue
    const isGone = (e) => /forbidden|chat not found|deactivated|blocked/i.test(e.description || '');
    const retryLater = (e) => !e.description || e.code === 429 || e.code >= 500;
    // Optional video or picture: sent together with the message when it fits in a caption, otherwise just before it
    const media = fu.video ? ['sendVideo', 'video', fu.video] : fu.image ? ['sendPhoto', 'photo', fu.image] : null;
    if (media) {
      const fits = text.replace(/<[^>]+>/g, '').length <= 1024;
      try {
        const body = { chat_id: chatId, [media[1]]: media[2] };
        if (fits) Object.assign(body, { caption: text, parse_mode: 'HTML', reply_markup });
        keep(await tg(media[0], body));
        if (fits) return { result: 'sent', idx, ids };
      } catch (e) {
        if (retryLater(e)) throw e;
        if (isGone(e)) return { result: 'gone' };
        console.error(tag, 'Follow-up media failed, sending the text only:', e.message);
      }
    }
    try {
      keep(await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup }));
      return { result: 'sent', idx, ids };
    } catch (e) {
      if (retryLater(e)) throw e;
      if (isGone(e)) return { result: 'gone' };
      console.error(tag, 'Follow-up HTML send failed, retrying as plain text:', e.message);
    }
    try {
      keep(await tg('sendMessage', { chat_id: chatId, text: text.replace(/<[^>]+>/g, ''), reply_markup }));
      return { result: 'sent', idx, ids };
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
          jobs.push({ chatId, planId: plan.id, stepId: plan.stepId, name: plan.name, item, avoid, prevIds: plan.lastMsgs });
        }
      }
      for (const job of jobs) {
        let out;
        if (job.item.step) {
          // "Open link, then show next step": the wait is over, send it (this also starts that step's own reminders)
          const plan0 = store.loadSchedule()[job.chatId];
          if (plan0) plan0.items = plan0.items.filter((i) => i !== job.item && !(i.fi === job.item.fi && i.k === job.item.k));
          try {
            await sendStep(Number(job.chatId), job.item.step, { first_name: job.name });
          } catch (e) {
            console.error(tag, 'Could not send next step:', e.message);
            if (plan0) store.saveSchedule(store.loadSchedule());
          }
          await sleep(40);
          continue;
        }
        try {
          out = await sendFollowup(Number(job.chatId), job.stepId, job.item.fi, job.name, job.avoid, job.prevIds);
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
              plan.lastMsgs = out.ids; // so the next reminder can delete this one
            }
            // A "keep repeating" follow-up is scheduled again with a fresh random wait; anything else is finished
            const fu = followupsFor(store.loadSteps(), job.stepId)[job.item.fi];
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
