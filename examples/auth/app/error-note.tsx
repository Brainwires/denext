import type { PageProps } from "denext/server";

/**
 * The message a page's table has for the query's `?error=` code, as an error paragraph — or
 * nothing. Only the table's OWN keys count, so a crafted `?error=constructor` can't render an
 * inherited property.
 */
export function ErrorNote(
  { messages, params }: { messages: Record<string, string>; params: PageProps["searchParams"] },
) {
  const code = String(params.error ?? "");
  return Object.hasOwn(messages, code) ? <p class="err">{messages[code]}</p> : null;
}
