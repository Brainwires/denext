// Temporarily replace members of a runtime object — the `Deno` namespace (`Deno.osRelease`,
// `Deno.resolveDns`, `Deno.Tray`) or a global (`navigator.permissions`, `Notification`) — that the
// code under test reads directly, restoring them afterwards (removing a member that did not exist).

/**
 * Run `fn` with `props` defined on `target`, then restore each one's previous own descriptor.
 *
 * @param target The object to patch.
 * @param props The members to define (an `undefined` value still defines the key).
 * @param fn The body.
 * @returns What `fn` returns.
 */
export async function withProps<T>(
  target: object,
  props: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = Object.keys(props).map((key) =>
    [key, Object.getOwnPropertyDescriptor(target, key)] as const
  );
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, had] of saved) {
      if (had) Object.defineProperty(target, key, had);
      else delete (target as Record<string, unknown>)[key];
    }
  }
}

/**
 * Run `fn` with `props` defined on the `Deno` namespace (see {@link withProps}).
 *
 * @param props The `Deno` members to define.
 * @param fn The body.
 * @returns What `fn` returns.
 */
export function withDenoProps<T>(
  props: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withProps(Deno, props, fn);
}
