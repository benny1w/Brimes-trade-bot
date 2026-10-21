const { loadSteps, trackUser, fillPlaceholders } = require('./lib');

const TOKEN = process.env.BOT_TOKEN;
const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org') + '/bot' + TOKEN;

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(`${method} failed: ${json.description}`);
    err.description = json.description;
    throw err;
  }
  return json.result;
}

function keyboardFor(step) {
  const buttons = step.buttons || [];
  if (!buttons.length) return undefined;
  // One button per row, like a menu
  return {
    inline_keyboard: buttons.map((b) =>
      b.url ? [{ text: b.label, url: b.url }] : [{ text: b.label, callback_data: b.goto }]
    ),
  };
}

async function sendStep(chatId, stepId, from) {
  const data = loadSteps(); // re-read every time, so admin edits go live instantly
  const step = data.steps[stepId];
  if (!step) {
    await tg('sendMessage', { chat_id: chatId, text: 'Sorry, that option is no longer available. Send /start to begin again.' });
    return;
  }
  const text = fillPlaceholders(step.text, from);
  const reply_markup = keyboardFor(step);

  if (step.image) {
    try {
      await tg('sendPhoto', { chat_id: chatId, photo: step.image });
    } catch (e) {
      console.error('Image failed, continuing without it:', e.message);
    }
  }
  try {
    await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup });
  } catch (e) {
    // Bad HTML in the text? Fall back to plain text so the user still gets the message.
    console.error('HTML send failed, retrying as plain text:', e.message);
    const plain = text.replace(/<[^>]+>/g, '');
    await tg('sendMessage', { chat_id: chatId, text: plain, reply_markup });
  }
}

async function handleUpdate(update) {
  if (update.message && update.message.text) {
    const msg = update.message;
    trackUser(msg.from);
    const text = msg.text.trim();
    if (text.startsWith('/start') || text.startsWith('/menu')) {
      await sendStep(msg.chat.id, loadSteps().start, msg.from);
    } else {
      // Any other message: show the main menu again
      await sendStep(msg.chat.id, loadSteps().start, msg.from);
    }
  } else if (update.callback_query) {
    const cq = update.callback_query;
    trackUser(cq.from);
    try {
      await tg('answerCallbackQuery', { callback_query_id: cq.id }); // stops the button's loading spinner
    } catch (e) {
      console.error(e.message);
    }
    if (cq.message) await sendStep(cq.message.chat.id, cq.data, cq.from);
  }
}

async function startBot() {
  if (!TOKEN) {
    console.error('BOT_TOKEN is missing. Put it in your .env file.');
    process.exit(1);
  }
  let offset = 0;
  console.log('Bot is running (long polling)...');
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((e) => console.error('Update error:', e.message));
      }
    } catch (e) {
      console.error('Polling error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

module.exports = { startBot };
