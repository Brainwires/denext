/**
 * Style sheets a library builds while rendering, written into the server-rendered `<head>`.
 *
 * A library that collects CSS at render time without `useServerInsertedHTML` — React Native
 * mode's react-native-web, whose `StyleSheet` keeps its rules in a sheet of its own — registers
 * a reader here by the id of the `<style>` element its client adopts
 * (`globalThis[Symbol.for("denext.serverStyleSheets")]`, a `Map` of id → reader; React Native
 * mode's server bundle does so, see ../build/react-native-app-router.ts). After a page's shell has
 * rendered, the page renderer (../server/render-page.ts, where the `useServerInsertedHTML`
 * markup is hoisted) writes each registered sheet into the `<head>` as `<style id="…">`. It is
 * read there, not in the JSX renderers, which also ship in client bundles. The registry is a `globalThis` map under a `Symbol.for` key,
 * so a sheet registered by a separately bundled copy of the library (the compat server bundle)
 * reaches the renderer; registering an id again replaces its reader (a dev rebuild).
 * @module
 */

/** A registered sheet's current contents. */
interface ServerStyleSheet {
  /** The `<style>` element's id (the one the library's client adopts). */
  readonly id: string;
  /** The sheet's CSS text. */
  readonly textContent: string;
}

/** Reads a registered sheet now (null: nothing to write). */
type ServerStyleSheetReader = () => ServerStyleSheet | null | undefined;

const REGISTRY = Symbol.for("denext.serverStyleSheets");

/** The registry (absent until a sheet registers). */
function registry(): Map<string, ServerStyleSheetReader> | undefined {
  return (globalThis as Record<symbol, Map<string, ServerStyleSheetReader> | undefined>)[REGISTRY];
}

/** Escape an attribute value. */
function attr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * The registered sheets as `<style>` elements, in registration order; "" when none is
 * registered (every app without such a library). A `</style` inside the CSS is escaped so it
 * cannot close the element.
 */
export function serverStyleSheetsHtml(): string {
  const sheets = registry();
  if (!sheets || sheets.size === 0) return "";
  let html = "";
  for (const [id, read] of sheets) {
    const sheet = read();
    if (!sheet || sheet.textContent === "") continue;
    const css = sheet.textContent.replace(/<\/(style)/gi, "<\\/$1");
    html += `<style id="${attr(sheet.id || id)}">${css}</style>`;
  }
  return html;
}
