// src/index.ts
import express from 'express';
import { Telegraf, Context } from 'telegraf';
import { config, findWorkspace } from './config';
import {
  ApiCredentials,
  BuyerRow,
  DateRange,
  getBuyers,
  getCampaigns,
  getConcurrency,
  getDestinations,
  getMissed,
  todayInTimezone,
} from './api';
import {
  allGroups,
  credentialsFor,
  getGroup,
  GroupSettings,
  maskKey,
  moveGroup,
  updateGroup,
} from './store';
import {
  buildBuyerCapacity,
  escapeHtml,
  formatBuyers,
  formatCampaigns,
  formatCcUpdate,
  formatDestinations,
  formatMissed,
  splitMessage,
} from './format';
import { log, logError, redact } from './logger';

const bot = new Telegraf(config.telegramBotToken);
const app = express();

// One line per command, so the API responses that follow have context
bot.use(async (ctx, next) => {
  const text = (ctx.message as any)?.text as string | undefined;
  if (text?.startsWith('/')) {
    const shown = text.replace(/^(\/setapikey\S*\s+)(\S+)/i, (_, command, key) => command + maskKey(key));
    const chat = ctx.chat && 'title' in ctx.chat ? ctx.chat.title : ctx.chat?.id;
    log(`${redact(shown)}  (${chat}, @${ctx.from?.username || ctx.from?.id})`);
  }
  await next();
});

// Per-chat processing flag so one chat can't stack up concurrent requests
const processing = new Set<number>();

const CLEAR_WORDS = ['clear', 'reset', 'none', 'default'];

// Helpers
const getChatId = (ctx: Context): number => ctx.chat!.id;

const getArgs = (ctx: Context): string => {
  const text = (ctx.message as any)?.text as string | undefined;
  return (text || '').split(/\s+/).slice(1).join(' ').trim();
};

const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

const replyHtml = async (ctx: Context, text: string): Promise<void> => {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }
};

// Only bot admins (BOT_ADMIN_USER_IDS) or, if none are configured, chat admins may change settings
const canConfigure = async (ctx: Context): Promise<boolean> => {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (config.botAdminUserIds.length > 0) return config.botAdminUserIds.includes(userId);
  if (ctx.chat?.type === 'private') return true;
  try {
    const member = await ctx.getChatMember(userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
};

const requireConfigure = async (ctx: Context): Promise<boolean> => {
  if (await canConfigure(ctx)) return true;
  await ctx.reply('Only group admins can change the bot settings.');
  return false;
};

// Platform-wide stats are hidden from buyer groups and, when ADMIN_CHAT_IDS is set, from other chats
const canViewPlatform = (chatId: number, group: GroupSettings): boolean => {
  if (group.buyer || group.buyerKey) return false;
  return config.adminChatIds.length === 0 || config.adminChatIds.includes(chatId);
};

// A buyer chat (key set with "/setapikey KEY buyer", or a buyer set with /setbuyer) only gets
// /viewdestinations (and /help). Setup commands still work for admins but are not shown;
// anything else is ignored without a reply.
const isBuyerChat = (group: GroupSettings): boolean => !!(group.buyerKey || group.buyer);

const BUYER_CHAT_COMMANDS = ['viewdestinations', 'start', 'help'];
const BUYER_CHAT_ADMIN_COMMANDS = ['setapikey', 'setworkspace', 'setbuyer', 'clearconfig', 'settings', 'changedate', 'cancel', 'stopauto'];
const BUYER_CHAT_REPORTS = ['viewdestinations'];

bot.use(async (ctx, next) => {
  const text = (ctx.message as any)?.text as string | undefined;
  const command = text?.match(/^\/(\w+)/)?.[1].toLowerCase();
  if (!command || !ctx.chat || !isBuyerChat(getGroup(ctx.chat.id)) || BUYER_CHAT_COMMANDS.includes(command)) return next();
  if (BUYER_CHAT_ADMIN_COMMANDS.includes(command) && (await canConfigure(ctx))) return next();
});

// Commands are listed only by /help, not in Telegram's command menu. Menus set by older versions
// (bot-wide, and per chat for buyer chats) stay until deleted, so they are cleared on startup.
const clearCommandMenus = async (chatIds: number[]): Promise<void> => {
  const scopes = [undefined, ...chatIds.map(chatId => ({ type: 'chat' as const, chat_id: chatId }))];
  for (const scope of scopes) {
    try {
      await bot.telegram.deleteMyCommands(scope ? { scope } : undefined);
    } catch (error) {
      logError(`Command menu for ${scope ? `chat ${scope.chat_id}` : 'all chats'}`, error);
    }
  }
};

const requireCredentials = async (ctx: Context, group: GroupSettings): Promise<ApiCredentials | null> => {
  const creds = credentialsFor(group);
  if (!creds) {
    await ctx.reply('This chat has no API key yet. A group admin must set one with /setapikey KEY.');
  }
  return creds;
};

// Wraps a stats command with the per-chat lock and error reporting
const runCommand = (name: string, handler: (ctx: Context, group: GroupSettings) => Promise<void>) =>
  async (ctx: Context) => {
    const chatId = getChatId(ctx);
    if (processing.has(chatId)) {
      await ctx.reply('Please wait, the previous request is still processing...');
      return;
    }
    processing.add(chatId);
    try {
      await handler(ctx, getGroup(chatId));
    } catch (error: any) {
      logError(`/${name} in chat ${chatId}`, error);
      await ctx.reply(`Error running /${name}: ${error.message}`);
    } finally {
      processing.delete(chatId);
    }
  };

// Date filter per chat, like PDSO's /changedate, saved with the chat's other settings. Not set = today.
// "chatId:userId" of users who ran /changedate without a date and should send one next
const pendingDate = new Set<string>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (value: string): boolean => {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const shiftDays = (value: string, days: number): string => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// Accepts: today | yesterday | YYYY-MM-DD | YYYY-MM-DD YYYY-MM-DD (also "to" or "-" between the two)
const parseDateInput = (input: string): { range?: DateRange; error?: string } => {
  const today = todayInTimezone();
  const value = input.trim().toLowerCase();
  if (value === 'today' || CLEAR_WORDS.includes(value)) return {};
  if (value === 'yesterday') {
    const day = shiftDays(today, -1);
    return { range: { from: day, to: day } };
  }

  const parts = value.split(/\s+to\s+|\s+-\s+|\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || !parts.every(isRealDate)) {
    return { error: 'Invalid date. Use YYYY-MM-DD, for example 2026-10-10, or a range: 2026-10-01 2026-10-10' };
  }
  const [from, to = parts[0]] = parts;
  if (from > to) return { error: 'The start date must be on or before the end date.' };
  if (from > today) return { error: `${from} is in the future (today is ${today}).` };
  return { range: { from, to } };
};

const describeRange = (range?: DateRange): string | undefined =>
  !range ? undefined : range.from === range.to ? range.from : `${range.from} to ${range.to}`;

// The chat's date window, plus the label to show in headers (undefined when it is today)
const chatPeriod = (chatId: number): { range?: DateRange; label?: string } => {
  const range = getGroup(chatId).dateRange;
  if (!range) return {};
  const today = todayInTimezone();
  if (range.from === today && range.to === today) return {};
  return { range, label: describeRange(range) };
};

const applyDate = async (ctx: Context, input: string): Promise<void> => {
  const chatId = getChatId(ctx);
  const { range, error } = parseDateInput(input);
  if (error) {
    await ctx.reply(error);
    return;
  }
  pendingDate.delete(`${chatId}:${ctx.from?.id}`);

  const title = (ctx.chat as any).title;
  if (!range) {
    updateGroup(chatId, { dateRange: undefined, title });
    await ctx.reply(`Date filter reset to today (${todayInTimezone()}).`);
    return;
  }
  updateGroup(chatId, { dateRange: range, title });
  await ctx.reply(
    `Date filter set to ${describeRange(range)} for this chat only.\n\n` +
    `/viewbuyers, /viewcampaigns, /viewmissed and /viewdestinations now use this date.\n` +
    `/getccupdate always shows live figures.\n` +
    `Use /changedate today to go back to today.`
  );
};

const buyerHelpText = (chatId: number): string =>
  `<b>Avortyx Stats Bot</b>\n\n` +
  `/viewdestinations — Live and incoming for your numbers that received calls\n\n` +
  `Stats are for ${escapeHtml(chatPeriod(chatId).label || `today (${config.timezone})`)}.`;

const helpText = (): string =>
  `<b>Avortyx Stats Bot</b>\n\n` +
  `<b>Setup (group admins):</b>\n` +
  `/setworkspace NAME — Use a different API address from the bot config (optional)\n` +
  `/setapikey KEY — Set this chat's API key (required)\n` +
  `/setapikey KEY buyer — Use a buyer's own key: the chat then only gets /viewdestinations\n` +
  `/setbuyer NAME — Link this group to a buyer: the chat then only gets /viewdestinations\n` +
  `/clearconfig — Remove this chat's API key, buyer and workspace\n` +
  `/settings — Show this group's setup\n\n` +
  `<b>Statistics:</b>\n` +
  `/viewbuyers — Live, incoming and AHT per buyer\n` +
  `/viewcampaigns — Live, incoming, converted and AHT per campaign\n` +
  `/viewmissed — Missed calls per buyer\n` +
  `/getccupdate — Concurrent call capacity per buyer\n` +
  `/viewdestinations — Live and incoming for the buyer's numbers that received calls\n\n` +
  `<b>Autorun (group admins):</b>\n` +
  `Add <code>start MINUTES</code> to any statistics command to repeat it in this chat, ` +
  `e.g. <code>/viewdestinations start 5</code>. <code>/viewdestinations stop</code> stops it.\n` +
  `/stopauto — Stop all autoruns in this chat\n\n` +
  `<b>Date:</b>\n` +
  `/changedate [DATE] — Fetch stats for a date or range (YYYY-MM-DD, yesterday, today)\n` +
  `/cancel — Cancel a date change\n\n` +
  `Stats are for today (${escapeHtml(config.timezone)}) unless /changedate is used. ` +
  `Use <code>clear</code> with any /set command to reset it.`;

// General commands
bot.command(['start', 'help'], async ctx => {
  const chatId = getChatId(ctx);
  await replyHtml(ctx, isBuyerChat(getGroup(chatId)) ? buyerHelpText(chatId) : helpText());
});

bot.command('settings', async ctx => {
  const chatId = getChatId(ctx);
  const group = getGroup(chatId);
  const creds = credentialsFor(group);

  await replyHtml(
    ctx,
    `<b>Settings for this chat</b>\n\n` +
    `Chat ID: <code>${chatId}</code>\n` +
    `Workspace: ${escapeHtml(group.workspace || 'default')}\n` +
    `API key: ${creds ? escapeHtml(maskKey(creds.apiKey)) : 'not set (use /setapikey KEY)'}${group.buyerKey ? ' (buyer key)' : ''}\n` +
    `Buyer: ${escapeHtml(group.buyer || 'not set (platform view)')}\n` +
    `Commands: ${isBuyerChat(group) ? 'only /viewdestinations (buyer chat)' : 'all'}\n` +
    `Date: ${escapeHtml(chatPeriod(chatId).label || `today (${todayInTimezone()})`)}\n` +
    `Autoruns: ${escapeHtml(describeAutoruns(group))}`
  );
});

bot.command('changedate', async ctx => {
  const args = getArgs(ctx);
  if (args) {
    await applyDate(ctx, args);
    return;
  }

  const chatId = getChatId(ctx);
  pendingDate.add(`${chatId}:${ctx.from?.id}`);
  // force_reply makes the user's answer reach the bot even with group privacy mode on
  await ctx.reply(
    `Current date filter: ${chatPeriod(chatId).label || `today (${todayInTimezone()})`}\n\n` +
    `Reply with a new date (YYYY-MM-DD)\n` +
    `Example: 2026-10-10\n` +
    `Range: 2026-10-01 2026-10-10\n` +
    `Or: yesterday, today\n` +
    `Send /cancel to keep the current date.`,
    {
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'YYYY-MM-DD' },
      reply_parameters: { message_id: ctx.message.message_id },
    }
  );
});

bot.command('cancel', async ctx => {
  const chatId = getChatId(ctx);
  pendingDate.delete(`${chatId}:${ctx.from?.id}`);
  await ctx.reply(`Date change cancelled. Current date: ${chatPeriod(chatId).label || `today (${todayInTimezone()})`}`);
});

// Setup commands
bot.command('setworkspace', async ctx => {
  if (!(await requireConfigure(ctx))) return;
  const chatId = getChatId(ctx);
  const name = getArgs(ctx);
  const available = config.workspaces.map(ws => ws.name).join(', ') || 'none configured';

  if (!name) {
    await ctx.reply(`Usage: /setworkspace NAME\nAvailable workspaces: ${available}`);
    return;
  }
  if (CLEAR_WORDS.includes(name.toLowerCase())) {
    updateGroup(chatId, { workspace: undefined, title: (ctx.chat as any).title });
    await ctx.reply(`Workspace cleared. This chat now uses ${config.baseUrl}.`);
    return;
  }

  const workspace = findWorkspace(name);
  if (!workspace) {
    await ctx.reply(`Unknown workspace "${name}". Available workspaces: ${available}`);
    return;
  }
  updateGroup(chatId, { workspace: workspace.name, title: (ctx.chat as any).title });
  await ctx.reply(`Workspace set to "${workspace.name}".` + (getGroup(chatId).apiKey ? '' : '\nNow set this chat\'s API key with /setapikey KEY.'));
});

bot.command('setapikey', async ctx => {
  if (!(await requireConfigure(ctx))) return;
  const chatId = getChatId(ctx);
  const [key = '', mode, ...extra] = getArgs(ctx).split(/\s+/);
  const usage =
    'Usage: /setapikey KEY [buyer]\n' +
    'Add buyer when it is a buyer\'s own key: the chat then only gets /viewdestinations.\n' +
    'The message with the key is deleted after it is read.';

  if (!key) {
    await ctx.reply(usage);
    return;
  }
  if (CLEAR_WORDS.includes(key.toLowerCase())) {
    updateGroup(chatId, { apiKey: undefined, buyerKey: undefined, title: (ctx.chat as any).title });
    await ctx.reply('API key cleared. Stats commands will not work in this chat until /setapikey is used again.');
    return;
  }

  // Keep the key out of the chat history
  let deleted = true;
  try {
    await ctx.deleteMessage();
  } catch {
    deleted = false;
  }

  if ((mode && mode.toLowerCase() !== 'buyer') || extra.length > 0) {
    await ctx.reply(usage);
    return;
  }
  const buyerKey = mode !== undefined;

  const workspace = findWorkspace(getGroup(chatId).workspace);
  try {
    await getConcurrency({ baseUrl: workspace?.baseUrl || config.baseUrl, apiKey: key });
  } catch (error: any) {
    await ctx.reply(`That API key did not work: ${error.message}`);
    return;
  }

  updateGroup(chatId, { apiKey: key, buyerKey: buyerKey || undefined, title: (ctx.chat as any).title });
  const stopped = stopBlockedAutoruns(chatId);
  await ctx.reply(
    `API key saved (${maskKey(key)}).` +
    (buyerKey ? '\nBuyer key: this chat now only shows /viewdestinations. Set the key again without "buyer" to undo.' : '') +
    describeStopped(stopped) +
    (deleted ? '' : '\nI could not delete your message. Delete it yourself, or make me an admin with "Delete messages" permission.')
  );
});

// Finds a buyer by name (case-insensitive) among buyers that still exist
const findBuyer = async (creds: ApiCredentials, name: string): Promise<BuyerRow | undefined> => {
  const buyers = await getBuyers(creds, undefined, true);
  return buyers.find(b => b.status && b.status !== 'archived' && sameName(b.buyer_name, name));
};

// The group's buyer ID, looked up and saved on first use for groups set up by name only
const buyerIdFor = async (chatId: number, group: GroupSettings, creds: ApiCredentials): Promise<string | undefined> => {
  if (group.buyerId || !group.buyer) return group.buyerId;
  const buyer = await findBuyer(creds, group.buyer);
  if (buyer) updateGroup(chatId, { buyerId: buyer.buyer_id, buyer: buyer.buyer_name });
  return buyer?.buyer_id;
};

bot.command('setbuyer', runCommand('setbuyer', async (ctx, group) => {
  if (!(await requireConfigure(ctx))) return;
  const chatId = getChatId(ctx);
  const name = getArgs(ctx);

  if (!name) {
    await ctx.reply('Usage: /setbuyer NAME (for example /setbuyer Q06)');
    return;
  }
  if (CLEAR_WORDS.includes(name.toLowerCase())) {
    updateGroup(chatId, { buyer: undefined, buyerId: undefined, title: (ctx.chat as any).title });
    await ctx.reply(
      getGroup(chatId).buyerKey
        ? 'Buyer cleared. This chat still only shows /viewdestinations because its API key is a buyer key.'
        : 'Buyer cleared. This chat now has the platform view and all commands.'
    );
    return;
  }

  const creds = await requireCredentials(ctx, group);
  if (!creds) return;
  const buyer = await findBuyer(creds, name);
  if (!buyer) {
    await ctx.reply(`No buyer named "${name}" was found. Check the spelling, or that this chat's API key can see that buyer.`);
    return;
  }

  updateGroup(chatId, { buyer: buyer.buyer_name, buyerId: buyer.buyer_id, title: (ctx.chat as any).title });
  const stopped = stopBlockedAutoruns(chatId);
  await ctx.reply(
    `Buyer set to "${buyer.buyer_name}"${buyer.status === 'paused' ? ' (currently paused)' : ''}.\n` +
    `This chat now only shows /viewdestinations, with this buyer's numbers that receive calls. ` +
    `Use /setbuyer clear or /clearconfig to undo.` +
    describeStopped(stopped)
  );
}));

// Back to an unconfigured chat: no API key, buyer or workspace, so no autorun can work either
bot.command('clearconfig', async ctx => {
  if (!(await requireConfigure(ctx))) return;
  const chatId = getChatId(ctx);
  const stopped = stopChatAutoruns(chatId);
  updateGroup(chatId, {
    apiKey: undefined,
    buyerKey: undefined,
    buyer: undefined,
    buyerId: undefined,
    workspace: undefined,
    title: (ctx.chat as any).title,
  });
  await ctx.reply(
    'Removed this chat\'s API key, buyer and workspace. Set it up again with /setapikey KEY.' + describeStopped(stopped)
  );
});

// Stats reports. Each one builds the message for a chat from that chat's saved settings,
// so the same code serves a one-off command and an autorun.
// A ChatError is a message meant for the chat (not a failure to log).
class ChatError extends Error {}

const NOT_AVAILABLE = 'This command is not available in this chat.';

const chatCredentials = (group: GroupSettings): ApiCredentials => {
  const creds = credentialsFor(group);
  if (!creds) throw new ChatError('This chat has no API key yet. A group admin must set one with /setapikey KEY.');
  return creds;
};

type Report = (chatId: number, group: GroupSettings) => Promise<string>;

const REPORTS: Record<string, Report> = {
  viewbuyers: async (chatId, group) => {
    if (!group.buyer && !canViewPlatform(chatId, group)) throw new ChatError(NOT_AVAILABLE);
    const { range, label } = chatPeriod(chatId);
    return formatBuyers(await getBuyers(chatCredentials(group), range), group.buyer, label);
  },

  viewcampaigns: async (chatId, group) => {
    if (!canViewPlatform(chatId, group)) throw new ChatError(NOT_AVAILABLE);
    const { range, label } = chatPeriod(chatId);
    return formatCampaigns(await getCampaigns(chatCredentials(group), range), label);
  },

  viewmissed: async (chatId, group) => {
    if (!group.buyer && !canViewPlatform(chatId, group)) throw new ChatError(NOT_AVAILABLE);
    const { range, label } = chatPeriod(chatId);
    const missed = await getMissed(chatCredentials(group), range);
    return formatMissed(missed.by_buyer, group.buyer, label);
  },

  // Always live: today's buyers (including idle ones) and every destination
  getccupdate: async (chatId, group) => {
    if (!canViewPlatform(chatId, group)) throw new ChatError(NOT_AVAILABLE);
    const creds = chatCredentials(group);
    const [buyers, destinations] = await Promise.all([getBuyers(creds, undefined, true), getDestinations(creds)]);
    return formatCcUpdate(buildBuyerCapacity(buyers, destinations));
  },

  // Destinations are the numbers that received calls in the chat's date window
  viewdestinations: async (chatId, group) => {
    if (!group.buyer && !group.buyerKey && !canViewPlatform(chatId, group)) throw new ChatError(NOT_AVAILABLE);
    const creds = chatCredentials(group);
    const buyerId = await buyerIdFor(chatId, group, creds);
    if (group.buyer && !buyerId) {
      throw new ChatError(`Buyer "${group.buyer}" was not found. A group admin can fix it with /setbuyer NAME.`);
    }

    const { range, label } = chatPeriod(chatId);
    const rows = await getDestinations(creds, range, { buyerId, hasCalls: true });
    return formatDestinations(
      // In a buyer group, never show numbers that belong to someone else
      buyerId ? rows.filter(d => d.buyer_id === buyerId) : rows,
      {
        // A buyer key only sees its own buyer's numbers
        showBuyer: !buyerId && !group.buyerKey,
        showLive: !range || range.to >= todayInTimezone(),
        singleDay: !range || range.from === range.to,
        period: label,
      }
    );
  },
};

const sendHtml = async (chatId: number, text: string): Promise<void> => {
  for (const chunk of splitMessage(text)) {
    await bot.telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }
};

// Autoruns, like PDSO's "/stats start 5": repeat a report in one chat every N minutes.
// Saved in the chat's settings (autoruns: { command: minutes }) and restored on startup.
const DEFAULT_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;

// "chatId:command" -> timer
const timers = new Map<string, NodeJS.Timeout>();

const clearTimer = (chatId: number, command: string): void => {
  const key = `${chatId}:${command}`;
  const timer = timers.get(key);
  if (timer) clearInterval(timer);
  timers.delete(key);
};

const clearChatTimers = (chatId: number): void => {
  for (const key of Array.from(timers.keys())) {
    if (key.startsWith(`${chatId}:`)) clearTimer(chatId, key.slice(key.indexOf(':') + 1));
  }
};

const stopAutorun = (chatId: number, command: string): boolean => {
  clearTimer(chatId, command);
  const autoruns = { ...getGroup(chatId).autoruns };
  if (!(command in autoruns)) return false;
  delete autoruns[command];
  updateGroup(chatId, { autoruns });
  return true;
};

const stopChatAutoruns = (chatId: number): string[] => {
  clearChatTimers(chatId);
  const stopped = Object.keys(getGroup(chatId).autoruns || {});
  if (stopped.length > 0) updateGroup(chatId, { autoruns: {} });
  return stopped;
};

// A buyer chat keeps only the autoruns of reports it is allowed to run
const stopBlockedAutoruns = (chatId: number): string[] => {
  const group = getGroup(chatId);
  if (!isBuyerChat(group)) return [];
  return Object.keys(group.autoruns || {}).filter(command => !BUYER_CHAT_REPORTS.includes(command) && stopAutorun(chatId, command));
};

const describeStopped = (stopped: string[]): string =>
  stopped.length > 0 ? `\nStopped autoruns: ${stopped.map(c => `/${c}`).join(', ')}` : '';

// The bot was removed from the chat, or the chat no longer exists
const isChatGone = (error: any): boolean =>
  error?.response?.error_code === 403 || /chat not found|bot was kicked/i.test(error?.description || '');

const autorunTick = async (chatId: number, command: string): Promise<void> => {
  if (processing.has(chatId)) {
    log(`Autorun /${command} in chat ${chatId} skipped: previous request still running`);
    return;
  }
  processing.add(chatId);
  try {
    log(`Autorun /${command} (chat ${getGroup(chatId).title || chatId})`);
    await sendHtml(chatId, await REPORTS[command](chatId, getGroup(chatId)));
  } catch (error: any) {
    if (error instanceof ChatError) {
      // The chat's setup no longer allows this report; stop instead of repeating the error
      stopAutorun(chatId, command);
      await bot.telegram.sendMessage(chatId, `Autorun /${command} stopped: ${error.message}`).catch(() => undefined);
    } else if (error?.response?.parameters?.migrate_to_chat_id) {
      // The group became a supergroup while the bot missed the notice; follow it
      migrateChat(chatId, error.response.parameters.migrate_to_chat_id);
    } else if (isChatGone(error)) {
      log(`Chat ${chatId} is no longer reachable, stopping its autoruns`);
      stopChatAutoruns(chatId);
    } else {
      // Temporary problems (API down, timeout) are logged and retried on the next tick
      logError(`Autorun /${command} in chat ${chatId}`, error);
    }
  } finally {
    processing.delete(chatId);
  }
};

const scheduleAutorun = (chatId: number, command: string, minutes: number): void => {
  clearTimer(chatId, command);
  timers.set(`${chatId}:${command}`, setInterval(() => void autorunTick(chatId, command), minutes * 60 * 1000));
};

// Restarts the timers saved for a chat (on startup, or after a supergroup upgrade)
const restoreChatAutoruns = (chatId: number): number => {
  const autoruns = Object.entries(getGroup(chatId).autoruns || {}).filter(([command]) => command in REPORTS);
  autoruns.forEach(([command, minutes]) => scheduleAutorun(chatId, command, minutes));
  return autoruns.length;
};

// Telegram gives a group a new chat ID when it becomes a supergroup; move its settings and autoruns
const migrateChat = (fromChatId: number, toChatId: number): void => {
  clearChatTimers(fromChatId);
  moveGroup(fromChatId, toChatId);
  restoreChatAutoruns(toChatId);
};

const describeAutoruns = (group: GroupSettings): string => {
  const entries = Object.entries(group.autoruns || {});
  return entries.length > 0 ? entries.map(([command, minutes]) => `/${command} every ${minutes} min`).join(', ') : 'none';
};

// Handles "/command", "/command start [MINUTES]" and "/command stop" for a stats report
const statsCommand = (command: string) => async (ctx: Context) => {
  const chatId = getChatId(ctx);
  const [action = '', value] = getArgs(ctx).toLowerCase().split(/\s+/);
  const usage = `Usage: /${command} [start MINUTES | stop]\nExample: /${command} start ${DEFAULT_INTERVAL_MINUTES}`;

  if (action && action !== 'start' && action !== 'stop') {
    await ctx.reply(usage);
    return;
  }
  // Autoruns change what the bot posts in the chat, so they are a setting like the others
  if (action && !(await requireConfigure(ctx))) return;

  if (action === 'stop') {
    await ctx.reply(stopAutorun(chatId, command) ? `Autorun /${command} stopped in this chat.` : `/${command} is not on autorun in this chat.`);
    return;
  }

  let minutes: number | undefined;
  if (action === 'start') {
    minutes = value === undefined ? DEFAULT_INTERVAL_MINUTES : Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
      await ctx.reply(`The interval must be a whole number of minutes from 1 to ${MAX_INTERVAL_MINUTES}.\n${usage}`);
      return;
    }
  }

  // Run once now; an autorun is only scheduled if this first run works
  if (processing.has(chatId)) {
    await ctx.reply('Please wait, the previous request is still processing...');
    return;
  }
  processing.add(chatId);
  try {
    await replyHtml(ctx, await REPORTS[command](chatId, getGroup(chatId)));
  } catch (error: any) {
    if (!(error instanceof ChatError)) logError(`/${command} in chat ${chatId}`, error);
    await ctx.reply(error instanceof ChatError ? error.message : `Error running /${command}: ${error.message}`);
    return;
  } finally {
    processing.delete(chatId);
  }

  if (minutes !== undefined) {
    updateGroup(chatId, { autoruns: { ...getGroup(chatId).autoruns, [command]: minutes }, title: (ctx.chat as any).title });
    scheduleAutorun(chatId, command, minutes);
    await ctx.reply(
      `Autorun on: /${command} every ${minutes} minute${minutes === 1 ? '' : 's'} in this chat only.\n` +
      `Stop it with /${command} stop, or /stopauto to stop all autoruns here.`
    );
  }
};

bot.command('viewbuyers', statsCommand('viewbuyers'));
bot.command('viewcampaigns', statsCommand('viewcampaigns'));
bot.command(['viewmissed', 'getmissed'], statsCommand('viewmissed'));
bot.command('getccupdate', statsCommand('getccupdate'));
bot.command('viewdestinations', statsCommand('viewdestinations'));

bot.command('stopauto', async ctx => {
  if (!(await requireConfigure(ctx))) return;
  const stopped = stopChatAutoruns(getChatId(ctx));
  await ctx.reply(
    stopped.length > 0
      ? `Stopped autoruns in this chat: ${stopped.map(c => `/${c}`).join(', ')}\nAutoruns in other chats keep running.`
      : 'No autoruns are running in this chat.'
  );
});

// A group that becomes a supergroup gets a new chat ID; keep its setup
bot.on('message', async (ctx, next) => {
  if ('migrate_to_chat_id' in ctx.message) migrateChat(ctx.chat.id, ctx.message.migrate_to_chat_id);
  return next();
});

// A date sent after /changedate (as a reply, or any message when privacy mode is off)
bot.on('text', async (ctx, next) => {
  const key = `${getChatId(ctx)}:${ctx.from.id}`;
  if (!pendingDate.has(key) || ctx.message.text.startsWith('/')) return next();
  await applyDate(ctx, ctx.message.text);
});

bot.catch((error, ctx) => {
  logError(`Update ${ctx.update.update_id}`, error);
});

// Express routes
app.get('/', (req, res) => {
  res.send('Avortyx stats bot is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    today: todayInTimezone(),
    workspaces: config.workspaces.length,
    groups: allGroups().length,
  });
});

// Start server
const startServer = async () => {
  log(`API ${config.baseUrl} | keys set per chat with /setapikey | ${config.timezone}, today ${todayInTimezone()} | workspaces: ${config.workspaces.map(ws => ws.name).join(', ') || 'none'}`);

  // The health check is only for hosts that require an open port; the bot itself needs none
  if (config.port) {
    app
      .listen(config.port, '0.0.0.0', () => log(`Health check on port ${config.port}`))
      .on('error', error => logError(`Health check could not use port ${config.port}, continuing without it`, error));
  }

  await clearCommandMenus(allGroups().map(g => g.chatId));

  // launch() resolves only when the bot stops, so don't await it
  bot
    .launch(() => {
      log(`Bot @${bot.botInfo?.username} running`);
      // Buyer chats set up before they were limited to /viewdestinations: stop their other autoruns
      allGroups().filter(isBuyerChat).forEach(g => stopBlockedAutoruns(g.chatId));
      const restored = allGroups().reduce((count, g) => count + restoreChatAutoruns(g.chatId), 0);
      if (restored > 0) log(`Restored ${restored} autorun(s)`);
    })
    .catch(error => {
      logError('Bot polling stopped', error);
      process.exit(1);
    });

  const stop = (signal: string) => {
    log(`${signal}, stopping bot`);
    bot.stop(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
};

process.on('unhandledRejection', reason => logError('Unhandled promise rejection', reason));
process.on('uncaughtException', error => {
  logError('Uncaught exception', error);
  process.exit(1);
});

startServer().catch(error => {
  logError('Failed to start', error);
  process.exit(1);
});
