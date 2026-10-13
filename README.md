# AVRSTK — Avortyx Stats Telegram Bot

Telegram bot (TypeScript + Telegraf) that reports today's call statistics from the
[Avortyx Stats API](https://avortyx.io/api/stats). All configuration lives in `.env`
(see `.env.example`); per-group settings made with the `/set...` commands are saved to `DATA_FILE`.

## Run

```bash
npm install
cp .env.example .env   # then fill in TELEGRAM_BOT_TOKEN
npm run dev            # or: npm run build && npm start
```

There is no default API key. The bot answers stats commands only in chats where an admin has run `/setapikey`.

## Deploy on a VPS with PM2

Run only **one** copy of the bot per token. Stop any local `npm run dev` first, or Telegram
rejects the second one with `409 Conflict`.

On the VPS (Ubuntu/Debian), once:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
mkdir -p ~/avrstk
```

From your machine (PowerShell, in the project folder), copy the code and `.env`:

```powershell
tar -czf avrstk.tgz src package.json package-lock.json tsconfig.json ecosystem.config.js .env.example README.md
scp avrstk.tgz .env USER@VPS_IP:~/avrstk/
# optional: keep the group settings you already made locally
scp -r data USER@VPS_IP:~/avrstk/
```

On the VPS:

```bash
cd ~/avrstk
tar -xzf avrstk.tgz && rm avrstk.tgz
npm ci
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # then run the sudo command it prints, so the bot starts after a reboot
```

Day to day:

```bash
pm2 status
pm2 logs avrstk-bot          # live logs (Ctrl+C to leave)
pm2 restart avrstk-bot
pm2 stop avrstk-bot
```

Updating: copy the new `avrstk.tgz` over as above, then on the VPS:

```bash
cd ~/avrstk && tar -xzf avrstk.tgz && rm avrstk.tgz
npm ci && npm run build
pm2 restart ecosystem.config.js
```

Group settings live in `data/groups.json` on the VPS; the update steps never overwrite it.

## Setting up a group

1. Add the bot to the group. Make it an admin with **Delete messages** so `/setapikey` can remove the key from the chat.
2. `/setapikey sk_live_...`: required. Use the bot key for an ops group, or the buyer's own key so a buyer group only sees that buyer's data.
3. `/setworkspace Main`: optional. Only needed to point the group at a different API address from `WORKSPACE_n_*`.
4. `/setbuyer Q06`: for a buyer group. The name is checked against the platform.

Then `/viewdestinations` shows live/cc and incoming/cap for each of the buyer's numbers that received calls.

## Commands

| Command | Output |
| --- | --- |
| `/viewbuyers` | Live, incoming, AHT per buyer |
| `/viewcampaigns` | Live, incoming, converted, AHT per campaign |
| `/viewmissed` (`/getmissed`) | Missed calls per buyer, fewest first |
| `/getccupdate` | Concurrency cap per buyer, EOD buyers last, Total CC / Free CC |
| `/viewdestinations` | Live/cc and incoming/cap for each number that received calls (the group's buyer only, or all buyers in a platform chat) |
| `/changedate [DATE]` | Use a past date (`2026-10-10`), a range (`2026-10-01 2026-10-10`), `yesterday` or `today` for `/viewbuyers`, `/viewcampaigns`, `/viewmissed`, `/viewdestinations` in this chat |
| `/COMMAND start [MINUTES]` | Autorun (group admins): post any statistics command now and then every MINUTES (default 5) in this chat, e.g. `/viewdestinations start 5` |
| `/COMMAND stop`, `/stopauto` | Stop one autorun, or every autorun in this chat |
| `/settings` | The group's current setup, including its autoruns |

Every setting (workspace, API key, buyer, date, autoruns) belongs to the chat it was set in and is saved
in `DATA_FILE`, so commands in one group never change the bot in another. When Telegram
upgrades a group to a supergroup (new chat ID), its settings move with it.

In a group with a buyer set, `/viewbuyers` and `/viewmissed` show only that buyer, and
`/viewcampaigns` and `/getccupdate` are disabled. `ADMIN_CHAT_IDS` limits the platform-wide
commands to specific chats.

## How `/getccupdate` is calculated

It reads today's buyers (`GET /buyers?include_idle=true`) and all destinations (`GET /destinations`):

- Archived buyers and deleted ones (`status: null`) are left out.
- A destination is **open** when it is enabled and none of its daily, monthly or global call caps is used up.
- A buyer is **EOD** when it is paused or has no open destinations.
- An active buyer's number is the total `concurrency_cap` of its open destinations. An EOD buyer shows the cap of its enabled destinations (or all of them if none are enabled).
- A cap of 0 means uncapped: the buyer shows `∞` and is left out of the totals.
- **Total CC** = sum over active buyers. **Free CC** = Total CC minus their live calls.

The same number can be on more than one destination row, and its call counters belong to the number,
so the bot counts each number once, preferring the enabled row.
