// Loopy's browser tools: a visible Chrome the user can watch, driven from the Deno side
// (voice/chrome.ts) and started on first use. The model opens pages, reads them (the text and a
// numbered list of links, buttons and inputs), clicks, types, scrolls and goes back. The rules
// (voice/browser-safety.ts) are enforced here, before the browser is touched:
//
// - only http(s) addresses open;
// - a page's content comes back wrapped as untrusted data, never as instructions;
// - no typing into password, payment-card or one-time-code fields, no file uploads (the file
//   chooser is never answered) and no downloads (Chrome denies them);
// - a click on anything submit-like, and any navigation that posts data (held by the browser while
//   Loopy acts, voice/post-gate.ts), waits for the user's Yes in Loopy's bubble (voice/confirm.ts).
//
// The browser is an interface, so the tests drive these tools with a fake one.

import {
  checkUrl,
  clickRefusal,
  hostOf,
  type PageElement,
  pageForModel,
  type PageSnapshot,
  refOf,
  submitLike,
  typingRefusal,
} from "./browser-safety.ts";
import type { Confirmations } from "./confirm.ts";
import type { ToolResult, VoiceTool } from "./tools.ts";
import { clip, tidy, UNTRUSTED_NOTE } from "./untrusted.ts";

/** A navigation that posts, held until the user answers. */
export interface HeldPost {
  readonly method: string;
  readonly url: string;
}

/** The browser, as the tools drive it (voice/chrome.ts over Chrome, a fake in tests). */
export interface BrowserDriver {
  /** Navigate to `url` and wait for it to load. */
  open(url: string): Promise<void>;
  /** The page's text and its numbered elements (renumbers them). */
  snapshot(): Promise<PageSnapshot>;
  /** Element `ref` as it is now, or `null` when the page has no such element any more. */
  element(ref: number): Promise<PageElement | null>;
  click(ref: number): Promise<void>;
  /** Put `text` in field `ref` (no key presses, so no Enter and no implicit submit). */
  fill(ref: number, text: string): Promise<void>;
  scroll(direction: "up" | "down"): Promise<void>;
  back(): Promise<void>;
  /** The posting navigation the last action started, if the browser is holding one. */
  heldPost(): HeldPost | null;
  /** Let the held navigation go on and wait for it to load, or fail it. */
  releasePost(allow: boolean): Promise<void>;
  /** Run `action` with posting navigations allowed (the user said yes). */
  approved<T>(action: () => Promise<T>): Promise<T>;
}

/** A refusal or failure the model may hear (its message is safe to pass on). */
export class BrowserError extends Error {
  override readonly name = "BrowserError";
}

/** Gets the browser, starting it on first use. */
export type DriverSource = () => Promise<BrowserDriver>;

/** The longest text typed at once. */
export const MAX_TYPED = 2_000;

/** What the tools need. */
export interface BrowserToolsOptions {
  readonly driver: DriverSource;
  readonly confirmations: Confirmations;
}

/** An error output. */
const refused = (error: string): ToolResult => ({ output: { ok: false, error } });

/** The page as the model reads it, after an action. */
async function pageResult(
  d: BrowserDriver,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  return {
    output: { ok: true, ...extra, note: UNTRUSTED_NOTE, ...pageForModel(await d.snapshot()) },
  };
}

/** The result of an action: the user's question when it started a post, else the page. */
async function afterAction(
  d: BrowserDriver,
  confirmations: Confirmations,
  extra?: Record<string, unknown>,
): Promise<ToolResult> {
  const held = d.heldPost();
  if (!held) return await pageResult(d, extra);
  return confirmations.ask(`Loopy is about to send data to ${hostOf(held.url)}. Go ahead?`, {
    run: async () => {
      await d.releasePost(true);
      return await pageResult(d, { submitted: true });
    },
    cancel: () => d.releasePost(false),
  });
}

/** Run `step` against the browser, turning a failure into an output the model can read. */
async function guarded(
  options: BrowserToolsOptions,
  step: (d: BrowserDriver) => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await step(await options.driver());
  } catch (err) {
    return refused(err instanceof BrowserError ? err.message : "The browser didn't respond.");
  }
}

/** Element `ref` from the arguments, or a refusal. */
async function target(
  d: BrowserDriver,
  args: unknown,
): Promise<{ el: PageElement } | { error: string }> {
  const ref = refOf((args as { ref?: unknown } | null)?.ref);
  if (ref === null) return { error: "ref must be a number from the page's list" };
  const el = await d.element(ref);
  return el ? { el } : { error: `There is no [${ref}] on the page now; read it again.` };
}

/** A tool's declaration. */
function definition(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): VoiceTool["definition"] {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}

const REF = { type: "integer", description: "The element's number from browser_read's list." };

/** browser_open */
function openTool(o: BrowserToolsOptions): VoiceTool {
  return {
    feature: "browser",
    definition: definition(
      "browser_open",
      "Open a web page in Loopy's browser (a window the user can watch) and read it.",
      { url: { type: "string", description: "An http or https address." } },
    ),
    run(args) {
      const checked = checkUrl((args as { url?: unknown } | null)?.url);
      if ("error" in checked) return refused(checked.error);
      return guarded(o, async (d) => {
        await d.open(checked.url);
        return await afterAction(d, o.confirmations);
      });
    },
  };
}

/** browser_read */
function readTool(o: BrowserToolsOptions): VoiceTool {
  return {
    feature: "browser",
    definition: definition(
      "browser_read",
      "Read the page in Loopy's browser: its text and a numbered list of links, buttons and inputs.",
    ),
    run: () => guarded(o, (d) => pageResult(d)),
  };
}

/** browser_click */
function clickTool(o: BrowserToolsOptions): VoiceTool {
  return {
    feature: "browser",
    definition: definition(
      "browser_click",
      "Click a link or button by its number. Anything that submits, buys, posts or deletes " +
        "asks the user first.",
      { ref: REF },
    ),
    run: (args) =>
      guarded(o, async (d) => {
        const t = await target(d, args);
        if ("error" in t) return refused(t.error);
        const refusal = clickRefusal(t.el);
        if (refusal) return refused(refusal);
        if (submitLike(t.el)) {
          const label = clip(tidy(t.el.text || t.el.label) || "that button", 60);
          const page = await d.snapshot();
          return o.confirmations.ask(`Click “${label}” on ${hostOf(page.url)}?`, {
            run: () =>
              d.approved(async () => {
                await d.click(t.el.ref);
                return await pageResult(d, { clicked: t.el.ref });
              }),
          });
        }
        await d.click(t.el.ref);
        return await afterAction(d, o.confirmations, { clicked: t.el.ref });
      }),
  };
}

/** browser_type */
function typeTool(o: BrowserToolsOptions): VoiceTool {
  return {
    feature: "browser",
    definition: definition(
      "browser_type",
      "Type text into an input by its number (it never presses Enter). Loopy refuses " +
        "password, card and one-time-code fields.",
      { ref: REF, text: { type: "string", description: "What to type." } },
    ),
    run: (args) => {
      const text = (args as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || text.length > MAX_TYPED) {
        return refused(`text must be a string of at most ${MAX_TYPED} characters`);
      }
      return guarded(o, async (d) => {
        const t = await target(d, args);
        if ("error" in t) return refused(t.error);
        const refusal = typingRefusal(t.el);
        if (refusal) return refused(refusal);
        await d.fill(t.el.ref, text);
        const held = d.heldPost();
        return held
          ? await afterAction(d, o.confirmations)
          : { output: { ok: true, typed: t.el.ref } };
      });
    },
  };
}

/** browser_scroll */
function scrollTool(o: BrowserToolsOptions): VoiceTool {
  return {
    feature: "browser",
    definition: definition(
      "browser_scroll",
      "Scroll the page up or down by a screen and read it.",
      {
        direction: { type: "string", enum: ["up", "down"] },
      },
    ),
    run: (args) => {
      const direction = (args as { direction?: unknown } | null)?.direction;
      if (direction !== "up" && direction !== "down") {
        return refused("direction must be up or down");
      }
      return guarded(o, async (d) => {
        await d.scroll(direction);
        return await pageResult(d);
      });
    },
  };
}

/** browser_back */
function backTool(o: BrowserToolsOptions): VoiceTool {
  return {
    feature: "browser",
    definition: definition("browser_back", "Go back to the previous page and read it."),
    run: () =>
      guarded(o, async (d) => {
        await d.back();
        return await afterAction(d, o.confirmations);
      }),
  };
}

/** The browser tools: open, read, click, type, scroll and back. */
export function browserTools(options: BrowserToolsOptions): VoiceTool[] {
  return [
    openTool(options),
    readTool(options),
    clickTool(options),
    typeTool(options),
    scrollTool(options),
    backTool(options),
  ];
}
