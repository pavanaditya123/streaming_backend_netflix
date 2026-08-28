/**
 * A tiny in-memory table engine used by the `memory` data driver.
 *
 * It is NOT a SQL engine — each repository has two implementations (Postgres
 * and memory) behind the same interface. That keeps the real SQL visible in the
 * codebase while letting the entire platform boot with no database installed.
 */

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

export class MemoryTable {
  constructor(name, { primaryKey = 'id' } = {}) {
    this.name = name;
    this.primaryKey = primaryKey;
    this.rows = new Map();
    this.seq = 0;
  }

  insert(row) {
    const pk = row[this.primaryKey];
    if (pk === undefined) throw new Error(`${this.name}: missing primary key "${this.primaryKey}"`);
    if (this.rows.has(pk)) throw Object.assign(new Error(`duplicate key ${pk}`), { code: '23505' });
    this.seq += 1;
    const stored = { ...clone(row), __seq: this.seq };
    this.rows.set(pk, stored);
    return this.#out(stored);
  }

  upsert(row) {
    const pk = row[this.primaryKey];
    const existing = this.rows.get(pk);
    if (existing) {
      Object.assign(existing, clone(row));
      return this.#out(existing);
    }
    return this.insert(row);
  }

  findByPk(pk) {
    return this.#out(this.rows.get(pk));
  }

  findOne(predicate) {
    for (const row of this.rows.values()) if (predicate(row)) return this.#out(row);
    return null;
  }

  find(predicate = () => true, { sort, limit, offset = 0 } = {}) {
    let out = [...this.rows.values()].filter(predicate);
    out.sort(sort || ((a, b) => a.__seq - b.__seq));
    if (offset) out = out.slice(offset);
    if (limit !== undefined) out = out.slice(0, limit);
    return out.map((r) => this.#out(r));
  }

  count(predicate = () => true) {
    let n = 0;
    for (const row of this.rows.values()) if (predicate(row)) n += 1;
    return n;
  }

  update(pk, patch) {
    const row = this.rows.get(pk);
    if (!row) return null;
    Object.assign(row, clone(patch));
    return this.#out(row);
  }

  updateWhere(predicate, patch) {
    const updated = [];
    for (const row of this.rows.values()) {
      if (predicate(row)) {
        Object.assign(row, clone(patch));
        updated.push(this.#out(row));
      }
    }
    return updated;
  }

  delete(pk) {
    return this.rows.delete(pk);
  }

  deleteWhere(predicate) {
    let n = 0;
    for (const [pk, row] of [...this.rows.entries()]) {
      if (predicate(row)) {
        this.rows.delete(pk);
        n += 1;
      }
    }
    return n;
  }

  clear() {
    this.rows.clear();
    this.seq = 0;
  }

  #out(row) {
    if (!row) return null;
    const copy = clone(row);
    delete copy.__seq;
    return copy;
  }
}

export class MemoryDb {
  constructor() {
    this.tables = new Map();
  }

  table(name, options) {
    if (!this.tables.has(name)) this.tables.set(name, new MemoryTable(name, options));
    return this.tables.get(name);
  }

  clear() {
    for (const t of this.tables.values()) t.clear();
  }

  async healthy() {
    return true;
  }
}

let singleton = null;

export function getMemoryDb() {
  if (!singleton) singleton = new MemoryDb();
  return singleton;
}

export function resetMemoryDb() {
  getMemoryDb().clear();
}
