import { randomUUID } from 'node:crypto';

/** Prefixed, collision-safe IDs, e.g. newId('img') -> "img_6f1c…". */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
