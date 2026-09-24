// The marker line on top of every native template file denext writes into a Capacitor project
// (`// denext-<family>-template: <version> sha256=<hex>`): the template generation and the
// SHA-256 of the rest of the file. A file whose marker still matches its body is an unedited
// denext template, which a later install may upgrade in place.

/**
 * Lowercase hex SHA-256 of `text`'s UTF-8 (also for recognising files shipped before markers).
 *
 * @param text The text.
 * @returns The digest as hex.
 */
export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `template` with its marker line: `// denext-<family>-template: <version> sha256=<hex>`.
 *
 * @param family The template family (`ota`, `auth-session`).
 * @param version The family's template generation.
 * @param template The template text.
 * @returns The file content.
 */
export async function renderMarkedTemplate(
  family: string,
  version: number,
  template: string,
): Promise<string> {
  return `// denext-${family}-template: ${version} sha256=${await sha256Text(
    template,
  )}\n${template}`;
}

/**
 * Whether `text` starts with a `family` marker line: `true` when its hash matches the rest of
 * the file, `false` when it does not, `undefined` when there is no such marker.
 *
 * @param family The template family.
 * @param text A file's content.
 * @returns Whether the marker matches, or undefined without one.
 */
export async function markedTemplateIntact(
  family: string,
  text: string,
): Promise<boolean | undefined> {
  const marker = new RegExp(`^// denext-${family}-template: \\d+ sha256=([0-9a-f]{64})\\n`)
    .exec(text);
  if (!marker) return undefined;
  return await sha256Text(text.slice(marker[0].length)) === marker[1];
}
