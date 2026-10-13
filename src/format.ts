// src/format.ts
// Builds the Telegram messages (HTML parse mode). Every tag opens and closes on
// the same line so long messages can be split on line breaks safely.
import { BuyerRow, CampaignRow, DestinationRow, displayNumber, MissedRow } from './api';

const SEPARATOR = '-----------------';
const CC_SEPARATOR = '-----------------------------';

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// period is shown only when the chat is not on today, e.g. "Buyers statistics (2026-10-10):"
const header = (title: string, period?: string): string =>
  `<b>${period ? `${title} (${escapeHtml(period)}):` : `${title}:`}</b>\n\n`;

// Seconds -> HH:MM:SS
export const formatAht = (seconds: number | null | undefined): string => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
};

const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

export const formatBuyers = (rows: BuyerRow[], onlyBuyer?: string, period?: string): string => {
  const buyers = rows.filter(r => r.buyer_name && (!onlyBuyer || sameName(r.buyer_name, onlyBuyer)));
  if (buyers.length === 0) return header('Buyers statistics', period) + `No buyer activity ${period ? 'for this period' : 'today'}.`;

  const blocks = buyers.map(b =>
    `Buyer =&gt; ${escapeHtml(b.buyer_name)}\n` +
    `Live =&gt; ${b.live_calls || 0}\n` +
    `Incoming =&gt; ${b.total_calls || 0}\n` +
    `AHT =&gt; ${formatAht(b.avg_duration)}`
  );
  return header('Buyers statistics', period) + blocks.join(`\n${SEPARATOR}\n`) + `\n${SEPARATOR}`;
};

export const formatCampaigns = (rows: CampaignRow[], period?: string): string => {
  const campaigns = rows.filter(r => r.campaign_name).sort((a, b) => naturalCompare(a.campaign_name, b.campaign_name));
  if (campaigns.length === 0) return header('Campaigns statistics', period) + `No campaign activity ${period ? 'for this period' : 'today'}.`;

  const blocks = campaigns.map(c =>
    `Campaign =&gt; ${escapeHtml(c.campaign_name)}\n` +
    `Live =&gt; ${c.live_calls || 0}\n` +
    `Incoming =&gt; ${c.total_calls || 0}\n` +
    `Converted =&gt; ${c.converted_calls || 0}\n` +
    `AHT =&gt; ${formatAht(c.avg_duration)}`
  );
  return header('Campaigns statistics', period) + blocks.join(`\n${SEPARATOR}\n`) + `\n${SEPARATOR}`;
};

export const formatMissed = (rows: MissedRow[], onlyBuyer?: string, period?: string): string => {
  // Rows with no id are calls that never reached a buyer (e.g. refused before routing)
  const buyers = rows
    .filter(r => r.id && r.name && (!onlyBuyer || sameName(r.name, onlyBuyer)))
    .sort((a, b) => a.missed - b.missed || naturalCompare(a.name, b.name));
  if (buyers.length === 0) return header('Missed calls statistics', period) + `No buyer activity ${period ? 'for this period' : 'today'}.`;

  return header('Missed calls statistics', period) + buyers.map(b => `${escapeHtml(b.name)} - ${b.missed}`).join('\n');
};

// A cap of 0 means uncapped
const capText = (cap: number): string => (cap > 0 ? String(cap) : '∞');

// The same TFN can sit on several destination rows (even for different buyers) and the
// call counters belong to the number, so keep one row per number, preferring an enabled one
export const uniqueByNumber = (rows: DestinationRow[]): DestinationRow[] => {
  const byNumber = new Map<string, DestinationRow>();
  for (const row of rows) {
    const existing = byNumber.get(row.tfn);
    if (!existing || (!existing.enabled && row.enabled)) byNumber.set(row.tfn, row);
  }
  return Array.from(byNumber.values());
};

export interface DestinationView {
  showBuyer: boolean; // platform view: say whose number it is
  showLive: boolean; // only meaningful when the window includes today
  singleDay: boolean; // the daily cap only applies to a single day
  period?: string;
}

export const formatDestinations = (rows: DestinationRow[], view: DestinationView): string => {
  const destinations = uniqueByNumber(rows).sort((a, b) =>
    naturalCompare(a.buyer_name || '', b.buyer_name || '') || b.incoming_calls - a.incoming_calls || b.live_calls - a.live_calls);
  if (destinations.length === 0) {
    return header('Destinations statistics', view.period) + `No calls to these numbers ${view.period ? 'for this period' : 'today'}.`;
  }

  const blocks = destinations.map(d => {
    const lines = [`Destination =&gt; ${displayNumber(d.tfn)}`];
    if (view.showBuyer) lines.push(`Buyer =&gt; ${escapeHtml(d.buyer_name || 'Unassigned')}`);
    if (view.showLive) lines.push(`Live =&gt; ${d.live_calls || 0}/${capText(d.concurrency_cap)} (cc)`);
    lines.push(view.singleDay
      ? `Incoming =&gt; ${d.incoming_calls || 0}/${capText(d.daily_cap)} (cap)`
      : `Incoming =&gt; ${d.incoming_calls || 0}`);
    return lines.join('\n');
  });
  return header('Destinations statistics', view.period) + blocks.join(`\n${SEPARATOR}\n`) + `\n${SEPARATOR}`;
};

// An enabled destination still takes calls unless one of its call caps is used up
const isOpen = (d: DestinationRow): boolean =>
  d.enabled &&
  !(d.daily_cap > 0 && d.daily_calls >= d.daily_cap) &&
  !(d.monthly_cap > 0 && d.monthly_calls >= d.monthly_cap) &&
  !(d.global_cap > 0 && d.global_calls >= d.global_cap);

export interface BuyerCapacity {
  name: string;
  cc: number;
  uncapped: boolean;
  live: number;
  eod: boolean;
}

// A buyer is EOD when it is paused or none of its destinations can take calls.
// Active buyers count the cc of their open destinations; EOD buyers show the cc of
// their enabled destinations (or all of them when none are enabled).
// Archived and deleted (status null) buyers are left out.
export const buildBuyerCapacity = (buyers: BuyerRow[], destinations: DestinationRow[]): BuyerCapacity[] =>
  buyers
    .filter(b => b.status === 'active' || b.status === 'paused')
    .map(b => {
      const rows = uniqueByNumber(destinations.filter(d => d.buyer_id === b.buyer_id));
      const open = rows.filter(isOpen);
      const eod = b.status === 'paused' || open.length === 0;
      const enabled = rows.filter(d => d.enabled);
      const counted = !eod ? open : enabled.length > 0 ? enabled : rows;
      return {
        name: b.buyer_name,
        cc: counted.reduce((sum, d) => sum + (d.concurrency_cap || 0), 0),
        uncapped: !eod && open.some(d => !d.concurrency_cap),
        live: eod ? 0 : open.reduce((sum, d) => sum + (d.live_calls || 0), 0),
        eod,
      };
    });

export const formatCcUpdate = (buyers: BuyerCapacity[]): string => {
  const order = (a: BuyerCapacity, b: BuyerCapacity) =>
    Number(a.uncapped) - Number(b.uncapped) || a.cc - b.cc || naturalCompare(a.name, b.name);
  const active = buyers.filter(b => !b.eod).sort(order);
  const eod = buyers.filter(b => b.eod).sort(order);

  // Uncapped buyers have no fixed capacity, so they are left out of the totals
  const capped = active.filter(b => !b.uncapped);
  const totalCc = capped.reduce((sum, b) => sum + b.cc, 0);
  const freeCc = Math.max(0, totalCc - capped.reduce((sum, b) => sum + b.live, 0));

  const lines = [
    ...active.map(b => `${escapeHtml(b.name)} - ${b.uncapped ? '∞' : b.cc}`),
    ...eod.map(b => `${escapeHtml(b.name)} - ${b.cc} EOD`),
  ];

  let text = header('Concurrent calls statistics');
  text += lines.length > 0 ? lines.join('\n') : 'No buyers found.';
  text += `\n${CC_SEPARATOR}\nTotal CC - ${totalCc}\nFree CC - ${freeCc}`;
  return text;
};

// Telegram rejects messages over 4096 chars; split on line breaks
export const splitMessage = (text: string, limit = 4000): string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
};
