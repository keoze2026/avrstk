# AVRSTK maintenance notes

How the bot is put together, why it works the way it does, and how to keep it running.
For setup, deployment and the command list, see [README.md](README.md). This file covers
what you need to know before changing the code.

## What the bot is

A Telegram bot (`@Avrstkbot`, TypeScript + Telegraf) that reads call statistics from the
Avortyx Stats API and posts them to Telegram groups. It started as an Avortyx version of the
earlier GRSTK bot, and some behaviour copies the PDSO bot (`/changedate`, `/stats start 5`-style
autoruns). The API reference is [docs/Avortyx_Stats_API_Documentation (1).docx](docs/).

There are two kinds of chat:

- **Platform (ops) chats** get every command: buyers, campaigns, missed, CC update, destinations.
- **Buyer chats** get only `/viewdestinations`, limited to that buyer's numbers. A chat becomes
  a buyer chat through `/setbuyer NAME` or `/setapikey KEY buyer`.

## Code map

| File | What it holds |
| --- | --- |
| [src/index.ts](src/index.ts) | Bot wiring: middleware, commands, reports, autoruns, chat migration, startup |
| [src/api.ts](src/api.ts) | Avortyx API client: one function per endpoint, plus request logging |
| [src/format.ts](src/format.ts) | Builds every message (HTML), the `/getccupdate` math, and message splitting |
| [src/store.ts](src/store.ts) | Per-chat settings, saved to `DATA_FILE` (`data/groups.json`) |
| [src/config.ts](src/config.ts) | Reads `.env`, including the `WORKSPACE_n_*` entries |
| [src/logger.ts](src/logger.ts) | `HH:MM:SS message` logging and API-key redaction |
| [ecosystem.config.js](ecosystem.config.js) | PM2 process file (single instance, fork mode) |

### How a command flows through `index.ts`

1. **`callApi` patch**: every outgoing `sendMessage` has its `/commands` wrapped in `<code>`.
2. **Logging middleware**: logs the command, chat and user, with the API key masked.
3. **Buyer-chat middleware**: in a buyer chat it lets through `/viewdestinations`, `/start` and `/help`.
   It also lets through the setup commands when an admin sends them. **Everything else is dropped
   without a reply.**
4. **Command handler**: stats commands go through `statsCommand(name)`, which handles plain runs
   plus `start MINUTES` and `stop`, then calls `REPORTS[name]`.
5. **`REPORTS`**: one function per stats command. It takes `(chatId, group)` and returns the HTML.
   One-off commands and autorun ticks both use it.

## Design decisions and why

These came out of earlier work on the bot. Read them before you "simplify" something.

**One bot process per token.** Telegram allows only one long-polling client per token, and a
second one gets `409 Conflict`. That's why PM2 runs `fork` mode with `instances: 1`. Stop any
local `npm run dev` before you start the VPS copy, and the other way round.

**No default API key.** Each chat must run `/setapikey`. The key is checked with a `/concurrency`
call before it is saved, and the bot then deletes the message containing it. That's why the bot
needs the *Delete messages* admin right.

**Everything is per chat.** Workspace, key, buyer, date filter and autoruns all live on the chat's
`GroupSettings` entry. `getGroup` returns a copy, so the only way to change settings is
`updateGroup`, which also saves the file. Writes go to a `.tmp` file first and then get renamed,
so a crash can't leave a half-written JSON file.

**Supergroup migration.** When a group is upgraded, Telegram gives it a new chat ID.
`migrateChat` moves the settings and restarts the autoruns. It runs from the
`migrate_to_chat_id` service message, and also from an autorun's send error if the bot missed
that message.

**Output is monospace (`<pre>`).** Added in the "monospace" commit so the columns line up on every
client, iOS included. Lines are padded before HTML escaping, and width is counted in code points,
so names with `&`, accents or emoji still line up. `splitMessage` cuts messages at 4000 chars and
closes and reopens `<pre>` across chunks. Keep that in mind if you add other multi-line tags.

**Commands in messages can't be tapped.** In groups, tapping `/viewbuyers` in a bot message sends
`/viewbuyers@Avrstkbot` straight away. To stop that, the bot wraps commands in `<code>`, so a tap
copies the text instead. This is a patch on **`Telegram.prototype.callApi`**, not on
`bot.telegram`. Telegraf creates a new `Telegram` instance for each update, so patching
`bot.telegram` missed every `ctx.reply`. The first attempt failed for exactly that reason
(commits "unclickable commands" and "unclickable commands2"). The patch covers only
`sendMessage`. Edits, captions and other methods are not rewritten.

**No Telegram command menu.** Commands appear only in `/help`. Menus set by older versions stay on
Telegram's side until deleted, so on startup `clearCommandMenus` deletes the bot-wide menu and
the menu of every known chat. Don't add `setMyCommands` back unless that's an intentional change.

**Buyer chats.** First this applied only to `/setapikey KEY buyer`. The "Flagging buyers 2" commit
extended it to `/setbuyer`. When a chat becomes a buyer chat, its autoruns of anything other than
`/viewdestinations` stop (`stopBlockedAutoruns`), and startup runs the same check for chats that
were set up earlier. A buyer chat never shows the Buyer column, and with a buyer ID set, rows from
other buyers are filtered out locally as well.

**Destinations show Name and Number.** The "destination name visible" commit added the
destination's name above the number.

**Replies are short.** The bot is live in client groups, so replies state the result
("API key cleared.", "Autorun on: /viewdestinations every 5 minutes.") and nothing more. They don't
explain how the bot works or point to other commands. Errors name the problem and leave the
fix to this file. Keep new messages in the same style.

### Data quirks the code works around

- **`/buyers?include_idle=true` returns a buyer twice** when it had calls: once with stats
  (`status: null`) and once as idle (with its status). `mergeBuyerRows` in `api.ts` combines them.
  Don't remove it or buyers will show up twice.
- **One number (TFN) can be on several destination rows**, sometimes under different buyers. Its
  call counters belong to the number, so `uniqueByNumber` keeps one row per number and prefers an
  enabled row.
- **A cap of 0 means uncapped.** It shows as `∞` and is left out of Total CC and Free CC.
- **Rows in `missed.by_buyer` with no `id`** are calls that never reached a buyer, so they are
  skipped.
- For the `/getccupdate` rules (open, EOD, totals), see the README section
  "How `/getccupdate` is calculated". The code is `buildBuyerCapacity` and `formatCcUpdate` in
  `format.ts`.

## Common changes

### Add a stats command

1. Add the API call in `api.ts`, and a case in `summarize` if you want a readable log line.
2. Add a `formatX` function in `format.ts`. Use `header`, `fields` or `columns`, and `mono`.
3. Add an entry to `REPORTS` in `index.ts`. Call `canViewPlatform`, and throw `ChatError` for
   messages the chat should see.
4. Register it: `bot.command('name', statsCommand('name'))`. Autorun works automatically.
5. Add it to `helpText()` and the README command table.
6. If buyer chats should have it, add it to `BUYER_CHAT_COMMANDS` and `BUYER_CHAT_REPORTS`.

### Add a setting

Add the field to `GroupSettings` in `store.ts`. If it changes what a chat can see, update
`/settings` and `/clearconfig`. Old entries in `groups.json` won't have the field, so treat
"missing" as the default. `load()` already shows how to drop an obsolete field (the old
`destinations` field).

### Add a workspace (different API address)

Add `WORKSPACE_<n>_NAME` and `WORKSPACE_<n>_BASE_URL` to `.env` on the VPS, then restart. Numbers
don't have to be consecutive. A blank base URL falls back to `AVORTYX_BASE_URL`.

## Running it

| Task | Command |
| --- | --- |
| Local dev | `npm run dev` (stop the VPS copy first) |
| Type check | `npm run typecheck` |
| Build | `npm run build` (output goes to `dist/`) |
| Status / logs | `pm2 status`, `pm2 logs avrstk-bot` |
| Restart | `pm2 restart avrstk-bot` |
| Deploy an update | `git push origin main`. The VPS picks it up within a minute (see below) |
| Deploy by hand (VPS) | `cd /root/avrstk && git pull && npm ci && npm run build && pm2 restart avrstk-bot` |

### Auto-deploy

This is the same system CallsTalk uses. On the VPS, `/root/avrstk` is a git clone of `main`, and cron
runs [deploy/autodeploy.sh](deploy/autodeploy.sh) every minute. When `main` has a new commit, the
script pulls it and runs only the steps the changed files need:

| Changed | Steps |
| --- | --- |
| `package.json` / `package-lock.json` | `npm ci` |
| `src/`, `tsconfig.json`, `package*.json` | `npm run build` |
| Anything except `*.md` and `docs/` | `pm2 startOrRestart ecosystem.config.js`, then check the bot stays online for 15 s |

If a step fails, or the bot doesn't stay up (bad token, `409 Conflict`, startup crash), the script
puts the previous commit back, rebuilds it and restarts it. The failed commit isn't tried again;
push a fix and that deploys as usual. To retry the same commit, for example after fixing `.env`,
run `rm /root/avrstk/.git/autodeploy-failed`.

The script does nothing, and logs why once, when files were edited on the server (`git status`),
when `main` was force-pushed, or when `git fetch` fails. It is paused, without logging, while the
folder is on a detached commit after a roll-back.

`.env` and `data/groups.json` are gitignored, so a deploy never touches them.

**Log:** `tail -50 /var/log/avrstk-deploy.log`. Each deploy starts with `deploying <new> over <old>`
and ends with `deployed <new>`, or `FAILED` and what happened next.

**Roll back:** `cd /root/avrstk && git checkout <good-commit> && npm ci && npm run build && pm2 restart avrstk-bot`.
That pauses auto-deploy. Once the fix is pushed, run `git checkout main && git pull` to resume it.

**Turn it off:** run `crontab -e` and delete the `avrstk/deploy/autodeploy.sh` line.

**Shared VPS.** If this is the same VPS as CallsTalk, it runs many other PM2 apps. The system Node
(v20) belongs to them. Don't upgrade it for this bot (the README's NodeSource step would do that).
The bot runs on Node 20, and npm only warns that `engines` asks for 22.

Don't run `npm run dev` locally while the VPS bot is up. Both copies would poll the same token
(`409 Conflict`).

There are no automated tests. Before deploying, run `npm run typecheck`, then try the changed
commands in a test group, in both a platform chat and a buyer chat.

### Back up the settings

`data/groups.json` is the bot's only state: API keys, buyers and autoruns for every group. It is
gitignored and the deploy steps never touch it. Copy it off the VPS now and then:

```powershell
scp USER@VPS_IP:~/avrstk/data/groups.json .\groups.backup.json
```

The file holds API keys in plain text. Don't commit it, paste it into chats, or share it.

### Reading the logs

- `/viewbuyers  (Group title, @user)` is a command arriving.
- `API /buyers [2026-10-23] 200 312ms | ...` is an API call, with its date window, status, time,
  and a summary of what came back.
- `Settings <chat>: field=value` is a settings change (keys are masked).
- `Autorun /cmd (chat ...)` is a scheduled tick. `... skipped: previous request still running`
  means the previous request in that chat hadn't finished.
- PM2 adds the date (`time: true`). The bot's own timestamps use the server's local clock, while
  "today" for stats uses `TIMEZONE` (default `America/New_York`). They can differ.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `409 Conflict` in logs, bot stops | A second copy is running with the same token. Stop the local one (or the other server). |
| "API key was rejected." | Key revoked or wrong workspace. Run `/setapikey` again, or check `/setworkspace` and `/settings`. |
| "Could not delete the message with the key" | The bot isn't an admin with *Delete messages*. The key is still in the chat, so delete it by hand. |
| "This chat is not set up yet." | No API key in this chat. An admin runs `/setapikey KEY`. |
| A command does nothing in a group | It's a buyer chat, which ignores those commands without replying. Check with `/settings` ("Commands: /viewdestinations only"). |
| "Only group admins can change the bot settings" | If `BOT_ADMIN_USER_IDS` is set, **only** those user IDs can configure the bot, and group admins can't. |
| "This command is not available in this chat" | A buyer chat, or `ADMIN_CHAT_IDS` is set and doesn't include this chat. |
| `Buyer "X" was not found` | The buyer was renamed, archived or deleted. Run `/setbuyer NEWNAME`. |
| Autorun stopped by itself | The chat's setup no longer allows that report (the bot posts why), or the bot was removed from the chat. |
| Old command menu still showing | Restart the bot: startup clears the menus. Telegram clients can take a while to refresh. |
| Commands in messages are tappable again | The `callApi` patch isn't applied, or the message wasn't sent with `sendMessage`. See "Commands in messages can't be tapped" above. |
| Columns don't line up | Text went outside `<pre>`, or something padded *after* escaping. Use `fields`/`columns` and `mono`. |

## Known gaps

- `redact()` in `logger.ts` masks only `sk_live_…` and `sk_test_…` keys. Keys in other formats
  (for example `avx_…`) are masked where the code calls `maskKey` (the `/setapikey` log line and
  settings changes), but nowhere else. Widen the pattern if keys could reach other log lines.
- The header comment in `api.ts` mentions `STATS_API.md`, which isn't in the repo. The reference
  is the `.docx` in `docs/`.
- Autoruns use `setInterval` from the moment they start, not clock-aligned times. A restart resets
  the timing.
- The `processing` lock covers the whole chat. While a manual command runs, an autorun tick due in
  the same chat is skipped, not queued.
- `/changedate` waits for a reply in memory (`pendingDate`), so a restart forgets it.

## History

| Date | Commit | Change |
| --- | --- | --- |
| 2026-10-13 | `bdc01fd` | First version: the GRSTK bot rebuilt for Avortyx |
| 2026-10-13 | `e974675` | PM2 `ecosystem.config.js` and VPS deploy steps |
| 2026-10-21 | `7c8c209` | All reports in monospace `<pre>` blocks with aligned columns |
| 2026-10-21 | `179f1b7` | `/setapikey KEY buyer`: buyer-key chats get only `/viewdestinations` |
| 2026-10-21 | `4249fb3` | `/setbuyer` also makes a buyer chat; `/clearconfig` added |
| 2026-10-22 | `37449de` | Telegram command menus removed, so commands appear only in `/help` |
| 2026-10-23 | `55c3aee` | Destination name shown in `/viewdestinations` |
| 2026-10-23 | `2816176`, `4a52e4d` | Commands in bot messages shown as code so they can't be tapped (prototype patch) |
