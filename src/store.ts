// src/store.ts
// Everything that changes how the bot behaves in a chat lives here, keyed by chat ID,
// so a command in one group never affects another. Persisted to a JSON file.
import fs from 'fs';
import path from 'path';
import { config, findWorkspace } from './config';
import { ApiCredentials, DateRange } from './api';
import { log, logError } from './logger';

export interface GroupSettings {
  chatId: number;
  title?: string;
  workspace?: string;
  apiKey?: string;
  buyer?: string;
  // Resolved from the buyer name when /setbuyer runs
  buyerId?: string;
  // Set with /changedate; not set = today
  dateRange?: DateRange;
  // Reports repeated in this chat ("/viewdestinations start 5"): command -> minutes
  autoruns?: Record<string, number>;
  updatedAt?: string;
}

const groups = new Map<number, GroupSettings>();

const load = (): void => {
  if (!fs.existsSync(config.dataFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(config.dataFile, 'utf8')) as GroupSettings[];
    // Drop the old "destinations" field from before the API listed them
    raw.forEach(({ destinations, ...g }: GroupSettings & { destinations?: string[] }) => groups.set(g.chatId, g));
    log(`Loaded settings for ${groups.size} chat(s) from ${config.dataFile}`);
  } catch (error) {
    logError(`Could not read ${config.dataFile}`, error);
  }
};

const save = (): void => {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  const tmp = `${config.dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Array.from(groups.values()), null, 2));
  fs.renameSync(tmp, config.dataFile);
};

load();

// Returns a copy, so a handler can never change the stored settings except through updateGroup
export const getGroup = (chatId: number): GroupSettings => ({ ...(groups.get(chatId) || { chatId }) });

export const updateGroup = (chatId: number, changes: Partial<GroupSettings>): GroupSettings => {
  const updated: GroupSettings = { ...getGroup(chatId), ...changes, chatId, updatedAt: new Date().toISOString() };
  groups.set(chatId, updated);
  const shown = Object.entries(changes)
    .filter(([field]) => field !== 'title')
    .map(([field, value]) => `${field}=${field === 'apiKey' && value ? maskKey(String(value)) : JSON.stringify(value ?? null)}`);
  log(`Settings ${updated.title || chatId}: ${shown.join(', ')}`);
  save();
  return updated;
};

// Telegram gives a group a new chat ID when it becomes a supergroup; carry its settings over
export const moveGroup = (fromChatId: number, toChatId: number): void => {
  const settings = groups.get(fromChatId);
  if (!settings) return;
  groups.delete(fromChatId);
  groups.set(toChatId, { ...settings, chatId: toChatId, updatedAt: new Date().toISOString() });
  log(`Settings ${settings.title || fromChatId}: moved from chat ${fromChatId} to ${toChatId} (upgraded to supergroup)`);
  save();
};

export const allGroups = (): GroupSettings[] => Array.from(groups.values());

// Only a key set in this chat with /setapikey is used; there is no default key
export const credentialsFor = (group: GroupSettings): ApiCredentials | null => {
  const workspace = findWorkspace(group.workspace);
  const baseUrl = workspace?.baseUrl || config.baseUrl;
  return group.apiKey ? { baseUrl, apiKey: group.apiKey } : null;
};

export const maskKey = (key: string): string =>
  key.length <= 12 ? '****' : `${key.slice(0, 8)}…${key.slice(-4)}`;
