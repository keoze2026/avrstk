// src/logger.ts
// Plain terminal logging: "HH:MM:SS message".
const time = (): string => new Date().toTimeString().slice(0, 8);

export const log = (message: string): void => console.log(`${time()} ${message}`);

export const logError = (message: string, error?: unknown): void => {
  const detail = error instanceof Error ? error.message : error !== undefined ? String(error) : '';
  console.error(`${time()} ERROR ${message}${detail ? `: ${detail}` : ''}`);
};

// Hides anything that looks like an API key before it reaches the terminal
export const redact = (text: string): string => text.replace(/sk_(live|test)_[A-Za-z0-9_-]+/g, m => `${m.slice(0, 12)}…`);
