/**
 * ULID generation for capture-event and object IDs.
 *
 * IDs are minted at capture time (timestamp + crypto randomness). They are
 * deliberately NOT derived from image content: identical bytes may be two
 * different dishes, and two frames of one dish may differ (AGENTS.md 3.2).
 * Idempotency comes from the adapter's entry registry, not from hashing.
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-char Crockford-base32 ULID: 48-bit ms timestamp + 80-bit randomness. */
export function ulid(now: number = Date.now()): string {
  let time = now;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(16); // use 16 of these 5-bit draws
  let out = timeChars.join('');
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[rand[i]! % 32]!;
  }
  return out;
}

export type IdFactory = (prefix: string) => string;

/** Default ID factory, e.g. newId('cap') -> "cap_01J9ABCD...". */
export const newId: IdFactory = (prefix) => `${prefix}_${ulid()}`;
