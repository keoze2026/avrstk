// src/format.ts
// Builds the Telegram messages (HTML parse mode). Results go in a <pre> block so every
// client (iOS included) renders them monospace and padded columns line up. Other tags
// open and close on the same line; splitMessage keeps <pre> balanced across chunks.
import { BuyerRow, CampaignRow, DestinationRow, displayNumber, MissedRow } from './api';

const SEPARATOR = '-----------------';
const CC_SEPARATOR = '-----------------------------';

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Width in characters, not UTF-16 units, so names with accents or emoji pad correctly
const width = (text: string): number => Array.from(text).length;

const padRight = (text: string, size: number): string => text + ' '.repeat(Math.max(0, size - width(text)));

// Lines are escaped here, after padding, so entities don't count toward the width
const mono = (lines: string[]): string => `<pre>${lines.map(escapeHtml).join('\n')}</pre>`;

type Pair = [string, string | number];

// "Label    => value", with the arrows lined up
const fields = (pairs: Pair[]): string[] => {
  const size = Math.max(...pairs.map(([label]) => width(label)));
  return pairs.map(([label, value]) => `${padRight(label, size)} => ${value}`);
};

// "Name   - value", with the dashes lined up
const columns = (pairs: Pair[]): string[] => {
  const size = Math.max(...pairs.map(([name]) => width(name)));
  return pairs.map(([name, value]) => `${padRight(name, size)} - ${value}`);
};

// Report blocks, each followed by a separator line
const blocksOf = (blocks: string[][]): string[] => blocks.flatMap(lines => [...lines, SEPARATOR]);

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
  if (buyers.length === 0) return header('Buyers statistics', period) + mono([`No buyer activity ${period ? 'for this period' : 'today'}.`]);

  const blocks = buyers.map(b => fields([
    ['Buyer', b.buyer_name],
    ['Live', b.live_calls || 0],
    ['Incoming', b.total_calls || 0],
    ['AHT', formatAht(b.avg_duration)],
  ]));
  return header('Buyers statistics', period) + mono(blocksOf(blocks));
};

export const formatCampaigns = (rows: CampaignRow[], period?: string): string => {
  const campaigns = rows.filter(r => r.campaign_name).sort((a, b) => naturalCompare(a.campaign_name, b.campaign_name));
  if (campaigns.length === 0) return header('Campaigns statistics', period) + mono([`No campaign activity ${period ? 'for this period' : 'today'}.`]);

  const blocks = campaigns.map(c => fields([
    ['Campaign', c.campaign_name],
    ['Live', c.live_calls || 0],
    ['Incoming', c.total_calls || 0],
    ['Converted', c.converted_calls || 0],
    ['AHT', formatAht(c.avg_duration)],
  ]));
  return header('Campaigns statistics', period) + mono(blocksOf(blocks));
};

export const formatMissed = (rows: MissedRow[], onlyBuyer?: string, period?: string): string => {
  // Rows with no id are calls that never reached a buyer (e.g. refused before routing)
  const buyers = rows
    .filter(r => r.id && r.name && (!onlyBuyer || sameName(r.name, onlyBuyer)))
    .sort((a, b) => a.missed - b.missed || naturalCompare(a.name, b.name));
  if (buyers.length === 0) return header('Missed calls statistics', period) + mono([`No buyer activity ${period ? 'for this period' : 'today'}.`]);

  return header('Missed calls statistics', period) + mono(columns(buyers.map((b): Pair => [b.name, b.missed])));
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
    return header('Destinations statistics', view.period) + mono([`No calls to these numbers ${view.period ? 'for this period' : 'today'}.`]);
  }

  const blocks = destinations.map(d => {
    const pairs: Pair[] = [['Name', d.name || '-'], ['Destination', displayNumber(d.tfn)]];
    if (view.showBuyer) pairs.push(['Buyer', d.buyer_name || 'Unassigned']);
    if (view.showLive) pairs.push(['Live', `${d.live_calls || 0}/${capText(d.concurrency_cap)} (cc)`]);
    pairs.push(['Incoming', view.singleDay
      ? `${d.incoming_calls || 0}/${capText(d.daily_cap)} (cap)`
      : d.incoming_calls || 0]);
    return fields(pairs);
  });
  return header('Destinations statistics', view.period) + mono(blocksOf(blocks));
};

export interface BuyerCapacity {
  name: string;
  cc: number;
  uncapped: boolean;
  live: number;
  eod: boolean;
  // Adds to Total CC / Free CC (a buyer with no enabled numbers does not)
  counted: boolean;
}

const sumOf = (rows: DestinationRow[], field: 'concurrency_cap' | 'live_calls'): number =>
  rows.reduce((sum, d) => sum + (d[field] || 0), 0);

// Counted the way the platform's Total CC is: every enabled number counts, even past its
// daily/monthly/global call cap (such numbers still take calls), and paused buyers count too.
// A buyer's cc is the API's own figure, which also respects a buyer-level cap.
// A buyer is EOD when it is paused or has no enabled numbers; one with no enabled numbers
// shows the cc of its disabled ones but adds nothing to the totals.
// Archived and deleted (status null) buyers are left out.
export const buildBuyerCapacity = (buyers: BuyerRow[], destinations: DestinationRow[]): BuyerCapacity[] =>
  buyers
    .filter(b => b.status === 'active' || b.status === 'paused')
    .map(b => {
      const rows = uniqueByNumber(destinations.filter(d => d.buyer_id === b.buyer_id));
      const enabled = rows.filter(d => d.enabled);
      const counted = enabled.length > 0;
      return {
        name: b.buyer_name,
        cc: counted ? b.concurrency_cap ?? sumOf(enabled, 'concurrency_cap') : sumOf(rows, 'concurrency_cap'),
        uncapped: enabled.some(d => !d.concurrency_cap),
        live: sumOf(enabled, 'live_calls'),
        eod: b.status === 'paused' || !counted,
        counted,
      };
    });

export const formatCcUpdate = (buyers: BuyerCapacity[]): string => {
  const order = (a: BuyerCapacity, b: BuyerCapacity) =>
    Number(a.uncapped) - Number(b.uncapped) || a.cc - b.cc || naturalCompare(a.name, b.name);
  const active = buyers.filter(b => !b.eod).sort(order);
  const eod = buyers.filter(b => b.eod).sort(order);

  // Uncapped buyers have no fixed capacity, so they are left out of the totals
  const capped = buyers.filter(b => b.counted && !b.uncapped);
  const totalCc = capped.reduce((sum, b) => sum + b.cc, 0);
  const freeCc = Math.max(0, totalCc - capped.reduce((sum, b) => sum + b.live, 0));

  // Buyers and totals share one column so every dash lines up
  const ccText = (b: BuyerCapacity): string | number => (b.uncapped ? '∞' : b.cc);
  const rows = columns([
    ...active.map((b): Pair => [b.name, ccText(b)]),
    ...eod.map((b): Pair => [b.name, `${ccText(b)} EOD`]),
    ['Total CC', totalCc],
    ['Free CC', freeCc],
  ]);
  const buyerRows = rows.slice(0, -2);

  return header('Concurrent calls statistics') + mono([
    ...(buyerRows.length > 0 ? buyerRows : ['No buyers found.']),
    CC_SEPARATOR,
    ...rows.slice(-2),
  ]);
};

// Length as Telegram counts it, after parsing the HTML: tags drop out, an entity is one character
const visibleLength = (text: string): number =>
  text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt);/g, '_').length;

// A separator line ends a report block, so a message may be cut after it
const isSeparator = (line: string): boolean => /^(<pre>)?-{10,}(<\/pre>)?$/.test(line);

// Telegram rejects messages over 4096 characters. Split between report blocks, so each block
// stays whole in one message; a block (or a report without separators) too long for one
// message is split between lines. A <pre> block cut in two is closed at the end of one chunk
// and reopened at the start of the next.
export const splitMessage = (text: string, limit = 4000): string[] => {
  const blocks: string[][] = [[]];
  for (const line of text.split('\n')) {
    blocks[blocks.length - 1].push(line);
    if (isSeparator(line)) blocks.push([]);
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  const add = (lines: string[], linesSize: number) => {
    if (size + linesSize > limit && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(...lines);
    size += linesSize;
  };
  for (const block of blocks) {
    const sizes = block.map(line => visibleLength(line) + 1);
    const blockSize = sizes.reduce((sum, n) => sum + n, 0);
    if (blockSize <= limit) add(block, blockSize);
    else block.forEach((line, i) => add([line], sizes[i]));
  }
  if (current.length > 0) chunks.push(current);

  let inPre = false;
  return chunks
    .map(lines => {
      const reopen = inPre;
      for (const line of lines) {
        const opens = line.lastIndexOf('<pre>');
        const closes = line.lastIndexOf('</pre>');
        if (opens !== closes) inPre = opens > closes;
      }
      return (reopen ? '<pre>' : '') + lines.join('\n') + (inPre ? '</pre>' : '');
    })
    .filter(chunk => chunk.replace(/<\/?pre>/g, '').trim().length > 0);
};
