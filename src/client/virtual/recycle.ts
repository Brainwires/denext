/**
 * Opt-in cell recycling for `VirtualList` (`recycle: true`). Each rendered item gets a cell
 * key from a pool per item type: an item that stays in the window keeps its cell, and a cell
 * whose item left the window is handed to an item of the same type entering in the same
 * render, so the reconciler updates that DOM subtree in place instead of unmounting one and
 * mounting another. Off by default: recycled cells carry component state and loaded images
 * from their previous item (FlashList #749 / #855), which is only safe for stateless rows.
 *
 * @module
 */

/** An item's identity and type. */
export interface RecycleItem {
  /** The item's own key. */
  readonly key: string | number;
  /** Its type (cells are only reused within a type). */
  readonly type: string | number;
}

/** Most spare cells kept per type between renders. */
const MAX_SPARE = 64;

/** Assigns cell keys to items, reusing cells within each type. */
export class RecyclePool {
  #cells = new Map<string | number, { readonly cell: string; readonly type: string | number }>();
  #spare = new Map<string | number, string[]>();
  #next = 0;

  /** The cell key for each of `items`, in order. */
  assign(items: readonly RecycleItem[]): string[] {
    const live = new Set<string | number>();
    for (const item of items) live.add(item.key);
    for (const [key, held] of this.#cells) {
      if (live.has(key)) continue;
      this.#cells.delete(key);
      this.#release(held.type, held.cell);
    }
    return items.map((item) => {
      const held = this.#cells.get(item.key);
      if (held && held.type === item.type) return held.cell;
      if (held) this.#release(held.type, held.cell);
      const cell = this.#spare.get(item.type)?.pop() ?? `${String(item.type)}~${this.#next++}`;
      this.#cells.set(item.key, { cell, type: item.type });
      return cell;
    });
  }

  /** Put a cell back in its type's spare list (bounded). */
  #release(type: string | number, cell: string): void {
    let list = this.#spare.get(type);
    if (!list) this.#spare.set(type, list = []);
    if (list.length < MAX_SPARE) list.push(cell);
  }
}
