// The reconnect journal of realtime from the database: every change one server instance received
// (keys only, as the triggers or the WAL reported them), numbered in arrival order, kept per table
// for a bounded time and count. A `useTableChanges` subscription remembers the position it was
// last delivered up to; when its browser reconnects, the changes after that position are replayed
// to it — re-read as the subscriber, exactly as live changes are. A position the journal no longer
// covers (its entries were dropped for age or count) answers `null`: the subscriber is told to
// re-read instead.
//
// Positions are this instance's own (a counter from 1, never reused while the process runs): a
// subscription lives on one instance, so a reconnect that reaches another one finds no
// subscription there and is told to re-read.

/** One journaled change. */
export interface JournalEntry<E> {
  /** Its position: increasing across every table. */
  pos: number;
  /** When it was journaled (epoch ms). */
  at: number;
  /** The change. */
  event: E;
}

/** One table's entries: `entries[start…]` are live; `floor` is the newest dropped position. */
interface TableLog<E> {
  entries: JournalEntry<E>[];
  start: number;
  floor: number;
}

/** Dropped entries left at the front of a table's array before it is compacted. */
const COMPACT_AT = 1_024;

/** The journal of one engine. */
export class ChangeJournal<E extends { table: string }> {
  #head = 0;
  #tables = new Map<string, TableLog<E>>();
  readonly #retentionMs: number;
  readonly #maxPerTable: number;
  readonly #now: () => number;

  /**
   * @param retentionMs How long an entry is kept.
   * @param maxPerTable Entries kept per table.
   * @param now The clock (tests).
   */
  constructor(retentionMs: number, maxPerTable: number, now: () => number = Date.now) {
    this.#retentionMs = retentionMs;
    this.#maxPerTable = maxPerTable;
    this.#now = now;
  }

  /** The newest position handed out (0 before the first change). */
  get head(): number {
    return this.#head;
  }

  /**
   * Journal a change.
   *
   * @param event The change.
   * @returns Its position.
   */
  append(event: E): number {
    const pos = ++this.#head;
    let log = this.#tables.get(event.table);
    if (!log) this.#tables.set(event.table, log = { entries: [], start: 0, floor: 0 });
    log.entries.push({ pos, at: this.#now(), event });
    this.#trim(log);
    return pos;
  }

  /**
   * Whether every change of `table` after `after` is still journaled.
   *
   * @param table The table.
   * @param after The position a subscriber was delivered up to.
   * @returns `false` when some were dropped.
   */
  covers(table: string, after: number): boolean {
    const log = this.#tables.get(table);
    if (!log) return true;
    this.#trim(log);
    return log.floor <= after;
  }

  /**
   * The changes of `table` after `after`, up to and including `upTo`, in order — or `null` when
   * some of them were dropped (the gap is older than the retention).
   *
   * @param table The table.
   * @param after The position a subscriber was delivered up to.
   * @param upTo The newest position to include.
   * @returns The entries, or `null`.
   */
  since(table: string, after: number, upTo: number): JournalEntry<E>[] | null {
    const log = this.#tables.get(table);
    if (!log) return [];
    this.#trim(log);
    if (log.floor > after) return null;
    const out: JournalEntry<E>[] = [];
    for (let i = log.start; i < log.entries.length; i++) {
      const entry = log.entries[i];
      if (entry.pos > upTo) break;
      if (entry.pos > after) out.push(entry);
    }
    return out;
  }

  /**
   * Entries held, across every table (tests and diagnostics): what is in memory now — an entry
   * past the retention counts until a {@linkcode prune} (or its table's next use) drops it.
   */
  get size(): number {
    let size = 0;
    for (const log of this.#tables.values()) size += log.entries.length - log.start;
    return size;
  }

  /**
   * Drop every table's entries past the retention or the count — so a table that went quiet
   * does not hold its last entries until its next change. An emptied table keeps only its floor
   * (what it no longer covers).
   */
  prune(): void {
    for (const log of this.#tables.values()) {
      this.#trim(log);
      if (log.start > 0 && log.start >= log.entries.length) {
        log.entries = [];
        log.start = 0;
      }
    }
  }

  /** Forget everything (the engine stopped). */
  clear(): void {
    this.#tables.clear();
  }

  /** Drop a table's entries past the count or older than the retention (raising its floor). */
  #trim(log: TableLog<E>): void {
    const cutoff = this.#now() - this.#retentionMs;
    while (
      log.start < log.entries.length &&
      (log.entries.length - log.start > this.#maxPerTable || log.entries[log.start].at < cutoff)
    ) {
      log.floor = log.entries[log.start].pos;
      log.start++;
    }
    if (log.start >= COMPACT_AT && log.start * 2 >= log.entries.length) {
      log.entries.splice(0, log.start);
      log.start = 0;
    }
  }
}
