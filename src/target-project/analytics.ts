import { EventEmitter } from 'node:events';
import type { AegisDb } from './db.js';

export interface ClickEvent {
  code: string;
  ts: string;
  referrer: string | null;
}

export const clickEvents = new EventEmitter();

export function publishClick(event: ClickEvent): void {
  clickEvents.emit('click', event);
}

/**
 * Consumer side of a deliberately small producer/consumer split: the
 * redirect handler only has to publish an event, not write to the database
 * inline, which mirrors how the shared-data-services org models "standardize
 * how data is served to others" even at this small scale.
 */
export function startClickConsumer(db: AegisDb): void {
  const insert = db.prepare('INSERT INTO click_events (code, ts, referrer) VALUES (@code, @ts, @referrer)');
  clickEvents.on('click', (event: ClickEvent) => {
    insert.run(event);
  });
}
