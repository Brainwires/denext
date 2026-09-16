// The predicate behind every `?q=` box in the panel.
//
// Two panels filter a list server-side — config keys and CLI verbs — and a third (the plugins
// panel's JSR search) queries a registry instead. The two local ones share this, so "how a query
// matches" is decided once: the form they render is `FilterForm` in `components.ts`, and the
// matching is here.

/**
 * Whether `haystack` satisfies every term of `query`.
 *
 * Case-insensitive substring matching with AND semantics: each whitespace-separated term has to
 * appear somewhere, so "base path" narrows rather than widens. That is how the docs-site search
 * behaves, and it is what makes a two-word query useful on a list of thirty.
 *
 * An empty query matches everything, which lets a caller pass the raw `?q=` through without
 * special-casing the unfiltered page.
 *
 * @param haystack The text to search — typically a name joined to its one-line description.
 * @param query The raw `?q=` value.
 * @returns Whether every term appears in `haystack`.
 */
export function matchesTerms(haystack: string, query: string): boolean {
  const text = haystack.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
    .every((term) => text.includes(term));
}

/**
 * What a filtered page says above its results: how many things matched, or that none did.
 *
 * @param count How many entries matched.
 * @param query The search that produced them.
 * @param noun What is being counted, singular (`"config key"`, `"verb"`).
 * @param suffix An optional clause appended before the full stop.
 * @returns The sentence to show.
 */
export function matchNote(count: number, query: string, noun: string, suffix = ""): string {
  if (count === 0) return `No ${noun} matches "${query}".`;
  const subject = count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
  const verb = count === 1 ? "matches" : "match";
  return `${subject} ${verb} "${query}"${suffix}.`;
}
