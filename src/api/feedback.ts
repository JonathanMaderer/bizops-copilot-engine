import fs from 'node:fs';
import path from 'node:path';

export interface FeedbackRecord {
  contactId: string;
  rating: 'up' | 'down';
  actualReason?: string;
  engineVerdict?: string;
  confidence?: number;
  reportedIssue?: string;
}

const FILE = path.resolve('data/corrections.jsonl');

/** Appends one JSON line per feedback event to data/corrections.jsonl. */
export function saveFeedback(rec: FeedbackRecord): void {
  if (!rec.contactId || (rec.rating !== 'up' && rec.rating !== 'down')) throw new Error('contactId and rating (up|down) are required');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify({ timestamp: new Date().toISOString(), ...rec }) + '\n');
}
