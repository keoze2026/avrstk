// src/api.ts
// Client for the Avortyx Stats API (read-only). See STATS_API.md / Avortyx_Stats_API_Documentation.docx.
import axios from 'axios';
import { config } from './config';
import { log } from './logger';

export interface ApiCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface BuyerRow {
  buyer_id: string;
  buyer_name: string;
  total_calls: number;
  connected_calls: number;
  not_connected_calls: number;
  live_calls: number;
  converted_calls?: number;
  avg_duration?: number;
  // active | paused | archived; null = buyer record deleted
  status?: string | null;
  // Sum of the concurrency caps of the buyer's enabled destinations
  concurrency_cap?: number;
}

export interface CampaignRow {
  campaign_id: string;
  campaign_name: string;
  total_calls: number;
  connected_calls: number;
  live_calls: number;
  converted_calls: number;
  avg_duration: number;
}

export interface MissedRow {
  id: string | null;
  name: string;
  missed: number;
  refused: number;
  incoming: number;
}

export interface MissedResponse {
  by_campaign: MissedRow[];
  by_buyer: MissedRow[];
}

export interface ConcurrencyResponse {
  total_cc: number;
  by_campaign: { id: string | null; name: string; cc: number }[];
  by_buyer: { id: string | null; name: string; cc: number }[];
  taken_at: string;
}

// Caps of 0 mean uncapped. live/daily/monthly/global counters belong to the number,
// so two destination rows on the same TFN report the same counters.
export interface DestinationRow {
  id: string;
  buyer_id: string | null;
  buyer_name: string | null;
  name: string;
  tfn: string;
  enabled: boolean;
  concurrency_cap: number;
  daily_cap: number;
  monthly_cap: number;
  global_cap: number;
  live_calls: number;
  daily_calls: number;
  monthly_calls: number;
  global_calls: number;
  // Calls in the requested date window
  incoming_calls: number;
}

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

// YYYY-MM-DD for "now" in the configured timezone
export const todayInTimezone = (timezone: string = config.timezone): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Inclusive window; when omitted the window is today
export interface DateRange {
  from: string;
  to: string;
}

const dateParams = (range?: DateRange): Record<string, string> => {
  const today = todayInTimezone();
  return { date_from: range?.from || today, date_to: range?.to || today, timezone_name: config.timezone };
};

export const displayNumber = (tfn: string): string => tfn.replace(/^\+/, '');

// Lists up to 10 items, then "+N more"
const listOf = (items: string[]): string =>
  items.length === 0 ? 'none' : items.slice(0, 10).join(', ') + (items.length > 10 ? `, +${items.length - 10} more` : '');

// One-line summary of what the server sent back
const summarize = (endpoint: string, data: any): string => {
  if (endpoint === 'buyers' && Array.isArray(data)) {
    const withCalls = data.filter((b: BuyerRow) => b.total_calls > 0);
    return `${data.length} buyer(s), ${withCalls.length} with calls: ${listOf(withCalls.map((b: BuyerRow) => `${b.buyer_name} live ${b.live_calls} in ${b.total_calls}`))}`;
  }
  if (endpoint === 'campaigns' && Array.isArray(data)) {
    return `${data.length} campaign(s): ${listOf(data.map((c: CampaignRow) => `${c.campaign_name} live ${c.live_calls} in ${c.total_calls} conv ${c.converted_calls}`))}`;
  }
  if (endpoint === 'missed' && Array.isArray(data?.by_buyer)) {
    return `missed by buyer: ${listOf(data.by_buyer.filter((b: MissedRow) => b.id).map((b: MissedRow) => `${b.name} ${b.missed}`))}`;
  }
  if (endpoint === 'concurrency' && data) {
    return `total cc ${data.total_cc}: ${listOf((data.by_buyer || []).map((b: { name: string; cc: number }) => `${b.name} ${b.cc}`))}`;
  }
  if (endpoint === 'destinations' && Array.isArray(data)) {
    const withCalls = data.filter((d: DestinationRow) => d.incoming_calls > 0 || d.live_calls > 0);
    return `${data.length} destination(s), ${withCalls.length} with calls: ${listOf(withCalls.map((d: DestinationRow) =>
      `${d.buyer_name} ${displayNumber(d.tfn)} live ${d.live_calls}/${d.concurrency_cap} in ${d.incoming_calls}${d.enabled ? '' : ' (disabled)'}`))}`;
  }
  return 'ok';
};

const apiGet = async <T>(creds: ApiCredentials, endpoint: string, params: Record<string, string> = {}): Promise<T> => {
  const url = `${creds.baseUrl}/${endpoint.replace(/^\//, '')}`;
  const window = params.date_from ? ` [${params.date_from === params.date_to ? params.date_from : `${params.date_from}..${params.date_to}`}]` : '';
  const filters = Object.entries(params)
    .filter(([key]) => !['date_from', 'date_to', 'timezone_name'].includes(key))
    .map(([key, value]) => ` ${key}=${value}`)
    .join('');
  const started = Date.now();
  try {
    const response = await axios.get<T>(url, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
      params,
      timeout: config.apiTimeoutMs,
    });
    log(`API /${endpoint}${window}${filters} ${response.status} ${Date.now() - started}ms | ${summarize(endpoint, response.data)}`);
    return response.data;
  } catch (error: any) {
    const status: number | undefined = error.response?.status;
    const body = error.response?.data?.detail || (typeof error.response?.data === 'string' ? 'not found' : error.message);
    log(`API /${endpoint}${window}${filters} ${status ?? 'FAILED'} ${Date.now() - started}ms | ${body}`);
    if (status === 401 || status === 403) {
      throw new ApiError('API key was rejected (unauthorized). Check /setapikey or /setworkspace.', status);
    }
    const detail = error.response?.data?.detail || error.message;
    throw new ApiError(`API request failed: ${detail}`, status);
  }
};

// With include_idle the API also returns buyers with no calls, but a buyer that had calls
// comes back twice: once with its stats (status null) and once as idle (with its status).
// Merge those so each buyer appears once.
const mergeBuyerRows = (rows: BuyerRow[]): BuyerRow[] => {
  const byId = new Map<string, BuyerRow>();
  for (const row of rows) {
    const existing = byId.get(row.buyer_id);
    if (!existing) {
      byId.set(row.buyer_id, row);
      continue;
    }
    const [withStats, other] = (existing.total_calls || 0) >= (row.total_calls || 0) ? [existing, row] : [row, existing];
    byId.set(row.buyer_id, {
      ...withStats,
      status: withStats.status ?? other.status ?? null,
      concurrency_cap: Math.max(withStats.concurrency_cap || 0, other.concurrency_cap || 0),
      live_calls: Math.max(withStats.live_calls || 0, other.live_calls || 0),
    });
  }
  return Array.from(byId.values());
};

export const getBuyers = async (creds: ApiCredentials, range?: DateRange, includeIdle = false): Promise<BuyerRow[]> => {
  const params = includeIdle ? { ...dateParams(range), include_idle: 'true' } : dateParams(range);
  return mergeBuyerRows(await apiGet<BuyerRow[]>(creds, 'buyers', params));
};

export const getCampaigns = (creds: ApiCredentials, range?: DateRange) => apiGet<CampaignRow[]>(creds, 'campaigns', dateParams(range));

export const getMissed = (creds: ApiCredentials, range?: DateRange) => apiGet<MissedResponse>(creds, 'missed', dateParams(range));

export const getConcurrency = (creds: ApiCredentials) => apiGet<ConcurrencyResponse>(creds, 'concurrency');

export interface DestinationFilters {
  buyerId?: string;
  hasCalls?: boolean;
  enabled?: boolean;
}

export const getDestinations = (creds: ApiCredentials, range?: DateRange, filters: DestinationFilters = {}) => {
  const params: Record<string, string> = dateParams(range);
  if (filters.buyerId) params.buyer_id = filters.buyerId;
  if (filters.hasCalls) params.has_calls = 'true';
  if (filters.enabled !== undefined) params.enabled = String(filters.enabled);
  return apiGet<DestinationRow[]>(creds, 'destinations', params);
};
