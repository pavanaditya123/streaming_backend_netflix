import { randomUUID, createHash } from 'node:crypto';

export const uuid = () => randomUUID();

/** Short, stable, human-scannable id with a domain prefix (e.g. sub_a1b2c3). */
export function prefixedId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Stable hash used for cache keys built from structured input. */
export function hashKey(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
