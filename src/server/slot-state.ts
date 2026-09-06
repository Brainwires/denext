// Parallel-route slot state across soft navigations (Next.js semantics).
//
// On a HARD load a slot the URL does not match renders its `default.tsx`. On a SOFT
// navigation Next keeps showing what the slot showed before — independent slot navigation
// is the whole point of parallel routes. The server records, per slot, the pathname it last
// matched (`ctx.renderedSlotState`) and ships the map in the hydration / nav data; the
// client echoes it on every soft-nav fetch in the `x-denext-slot-state` header, and an
// unmatched slot is re-rendered for its remembered pathname. Keys: `children` (the page of
// a slot-only URL, see `PageRoute.slotOnly`) and `<layoutIndex>:@name` for named slots.
// The header is client-controlled: it is parsed defensively and only ever fed to the router.

import type { RequestContext } from "./request-context.ts";

/** The request header a soft navigation echoes the slot state in (the client sends it too). */
const SLOT_STATE_HEADER = "x-denext-slot-state";
/** The state key for the page (`children`) slot. */
export const CHILDREN_SLOT = "children";

const MAX_ENTRIES = 32;
const MAX_KEY = 80;
const MAX_PATH = 2048;
const MAX_HEADER = 8192;
const KEY_RE = /^[\w@:.-]+$/;

/** The slot state a soft-nav request echoed, validated; `{}` when absent or malformed. */
export function readSlotState(request: Request): Record<string, string> {
  const raw = request.headers.get(SLOT_STATE_HEADER);
  if (!raw || raw.length > MAX_HEADER) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (
    const [key, value] of Object.entries(parsed as Record<string, unknown>).slice(0, MAX_ENTRIES)
  ) {
    const ok = key.length <= MAX_KEY && KEY_RE.test(key) && typeof value === "string" &&
      value.startsWith("/") && value.length <= MAX_PATH;
    if (ok) out[key] = value;
  }
  return out;
}

/** Remember that slot `key` rendered its match for `pathname` in this request. */
export function recordSlotState(
  ctx: RequestContext | null | undefined,
  key: string,
  pathname: string,
): void {
  if (!ctx) return;
  (ctx.renderedSlotState ??= {})[key] = pathname;
}
