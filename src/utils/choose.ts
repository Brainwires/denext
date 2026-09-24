/**
 * `choose(value, cases, defaultCase?)` — pick a branch by value and run it.
 *
 * A pure control-flow helper for rendering, borrowed from Lit's `choose`. It looks
 * `value` up in `cases` and calls the matching zero-argument function, returning its
 * result. When no case matches it calls `defaultCase` if one was given, otherwise it
 * returns `undefined`. Only the selected branch runs — the others are never invoked —
 * so it reads as a lazy `switch` you can drop straight into JSX.
 *
 * Because `defaultCase` is a separate argument rather than a `"default"` key, a `value`
 * of the literal string `"default"` matches a `default` entry in `cases`, not the fallback.
 *
 * @example Render one of several states
 * ```tsx
 * choose(status, {
 *   loading: () => <Spinner />,
 *   error: () => <ErrorBanner />,
 *   success: () => <DataTable rows={rows} />,
 * }, () => null);
 * ```
 *
 * @typeParam K - The union of case keys (the type of `value`).
 * @typeParam R - What each branch returns.
 */

/** The branch map `choose` selects from: an optional zero-argument function per case key. */
export type ChooseCases<K extends PropertyKey, R> = Partial<Record<K, () => R>>;

/**
 * Selects the branch for `value` and runs it, or `defaultCase` when none matches.
 *
 * @param value The key to look up in `cases`.
 * @param cases A partial map from key to a zero-argument branch function.
 * @param defaultCase Run when no case matches; omit it to get `undefined` instead.
 * @returns The selected branch's result, or `undefined` when nothing matched.
 */
export function choose<K extends PropertyKey, R>(
  value: K,
  cases: ChooseCases<K, R>,
  defaultCase?: () => R,
): R | undefined {
  const branch = cases[value] ?? defaultCase;
  return branch?.();
}
