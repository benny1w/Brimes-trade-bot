# Family Trade Bot

A Telegram bot where every message and button is editable from an admin web page. No dependencies, just Node 20.6+.

## Setup

1. Create a bot with @BotFather on Telegram and copy the token.
2. `cp .env.example .env` and fill in `BOT_TOKEN` and `ADMIN_PASSWORD`.
3. `npm start`
4. Open `http://localhost:3000/admin`. Username: `admin`, password: your `ADMIN_PASSWORD`.
5. Message your bot `/start`.

## How it works

- `steps.json` holds every step (message text, optional image, buttons).
- A button either goes to another step (`goto`) or opens a link (`url`).
- The bot re-reads `steps.json` on every message, so saving in the admin page is instant. No restart.
- `{name}` in a message is replaced with the person's Telegram first name.
- Bold and italic work with `<b>text</b>` and `<i>text</i>`.

## Hosting

The bot uses long polling, so it needs no public URL or webhook. It just needs to stay running somewhere (a VPS, Railway, Render, etc.). Run only ONE copy at a time, because two copies polling the same token will conflict.

The admin page uses basic auth. If you host it publicly, put it behind HTTPS (most hosts do this for you) so the password isn't sent in plain text.
