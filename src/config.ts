// src/config.ts
import 'dotenv/config';

// A workspace only picks which API a group talks to; the key always comes from /setapikey
export interface WorkspaceConfig {
  name: string;
  baseUrl: string;
}

const list = (value: string | undefined): string[] =>
  (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your_telegram_bot_token_here') {
  throw new Error('TELEGRAM_BOT_TOKEN is required in .env file');
}

const BASE_URL = (process.env.AVORTYX_BASE_URL || 'https://avortyx.io/api/stats').replace(/\/+$/, '');

// WORKSPACE_<n>_NAME / _BASE_URL, numbered from 1 with no upper limit
const loadWorkspaces = (): WorkspaceConfig[] => {
  const workspaces: WorkspaceConfig[] = [];
  const indexes = Object.keys(process.env)
    .map(key => key.match(/^WORKSPACE_(\d+)_NAME$/)?.[1])
    .filter((n): n is string => !!n)
    .sort((a, b) => Number(a) - Number(b));

  for (const n of indexes) {
    const name = (process.env[`WORKSPACE_${n}_NAME`] || '').trim();
    if (!name) continue;
    const baseUrl = (process.env[`WORKSPACE_${n}_BASE_URL`] || '').trim().replace(/\/+$/, '') || BASE_URL;
    workspaces.push({ name, baseUrl });
  }
  return workspaces;
};

export const config = {
  telegramBotToken: TELEGRAM_BOT_TOKEN,
  // Optional: only set when a host needs an HTTP health check (Render, Railway, etc.)
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
  baseUrl: BASE_URL,
  timezone: process.env.TIMEZONE || 'America/New_York',
  apiTimeoutMs: parseInt(process.env.API_TIMEOUT_MS || '30000', 10),
  workspaces: loadWorkspaces(),
  botAdminUserIds: list(process.env.BOT_ADMIN_USER_IDS).map(Number),
  adminChatIds: list(process.env.ADMIN_CHAT_IDS).map(Number),
  dataFile: process.env.DATA_FILE || './data/groups.json',
};

export const findWorkspace = (name: string | undefined): WorkspaceConfig | undefined =>
  name ? config.workspaces.find(ws => ws.name.toLowerCase() === name.toLowerCase()) : undefined;
