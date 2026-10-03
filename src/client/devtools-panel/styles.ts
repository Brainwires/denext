// DevTools panel: inline styles + the DOM element helper (see ../devtools-panel.ts for why
// styling is CSSOM-inline and never a <style> sheet).

// All panel inline styles + colors live inside a function (not at module scope) so
// esbuild tree-shakes the whole set out of production together with mount(): a bare
// top-level `const S = {…}` object literal is retained by esbuild even when every
// function using it is DCE'd, silently shipping ~2 KB of dead style strings in every
// production bundle. Nothing at module scope references these, so mount()'s removal in
// prod takes them with it.
export function buildStyles() {
  const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
  const ACCENT = "#8aa2ff";
  const CHANGED = "#ff9d5c"; // "why did this render" highlight
  // Inline style strings (see the module header for why a <style> sheet can't be used).
  const table = tableStyles(ACCENT);
  const S = {
    ...chromeStyles(MONO, ACCENT),
    ...tabStripStyles(),
    ...table,
    ...statusPillStyles(table.pill, ACCENT),
    ...layoutStyles(ACCENT),
    ...treeStyles(ACCENT),
    ...detailStyles(CHANGED),
    ...profilerStyles(MONO, ACCENT),
    ...consoleStyles(ACCENT),
  };
  // A capability badge (kept out of the literals above because it references ACCENT).
  const S_BADGE =
    `font-size:9px;color:#0c0e14;background:${ACCENT};border-radius:4px;padding:0 4px;margin-left:4px`;
  return { S, S_BADGE };
}

/** Launcher button, panel frame, header and tabs. */
function chromeStyles(MONO: string, ACCENT: string) {
  return {
    // Circular launcher showing the denext mascot's head-shot (see devtools-dino.ts);
    // overflow:hidden + border-radius:50% clip the square icon into the circle.
    launch: `position:fixed;left:12px;bottom:12px;z-index:2147483001;width:36px;height:36px;` +
      `padding:0;border:0;border-radius:50%;cursor:pointer;background:#12151c;overflow:hidden;` +
      `box-shadow:0 4px 18px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center`,
    // The icon is a square crop already framed with margin (see devtools-dino.ts), so it
    // just fills the button; the button's own circular clip (overflow:hidden +
    // border-radius:50%) masks it to a circle without cropping the mascot's snout.
    launchImg: `width:100%;height:100%;display:block;object-fit:cover`,
    launchShadow: "0 4px 18px rgba(0,0,0,.5)",
    launchShadowHover: `0 0 0 2px ${ACCENT},0 4px 20px rgba(0,0,0,.55)`,
    panel: `position:fixed;left:12px;bottom:12px;z-index:2147483002;width:min(620px,94vw);` +
      `height:min(460px,74vh);display:flex;flex-direction:column;font:12px/1.45 ${MONO};` +
      `color:#e6e9ef;background:#12151c;border:1px solid #2a3140;border-radius:10px;` +
      `box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden`,
    head: `display:flex;align-items:center;gap:8px;padding:7px 10px;background:#0c0e14;` +
      `border-bottom:1px solid #2a3140`,
    title: `color:${ACCENT};font-weight:600;letter-spacing:.02em`,
    tab:
      `background:none;border:0;color:#8b94a7;cursor:pointer;padding:3px 7px;border-radius:6px;font:inherit`,
    tabOn:
      `background:#1d2330;color:#e6e9ef;border-radius:6px;padding:3px 7px;border:0;cursor:pointer;font:inherit`,
  };
}

/**
 * The header's scrollable tab strip. Six tabs don't fit a 380 px panel, so the strip
 * scrolls horizontally (`overflow-x:auto`) and every button refuses to shrink
 * (`flex:0 0 auto`) instead of being squeezed into an unreadable column of letters.
 */
function tabStripStyles() {
  return {
    tabStrip: `display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow-x:auto`,
    tabItem: `flex:0 0 auto;background:none;border:0;color:#8b94a7;cursor:pointer;` +
      `padding:3px 7px;border-radius:6px;font:inherit;white-space:nowrap`,
    tabItemOn: `flex:0 0 auto;background:#1d2330;color:#e6e9ef;border:0;cursor:pointer;` +
      `padding:3px 7px;border-radius:6px;font:inherit;white-space:nowrap`,
  };
}

/** The shared table vocabulary of the data tabs (Network, Cache, Routes). */
function tableStyles(ACCENT: string) {
  return {
    table: `width:100%;border-collapse:collapse;font:inherit`,
    th: `text-align:left;padding:2px 6px;color:#8b94a7;font-weight:600;white-space:nowrap;` +
      `border-bottom:1px solid #1a202c`,
    td: `padding:2px 6px;border-bottom:1px solid #1a202c;vertical-align:top;word-break:break-all`,
    tdNum: `padding:2px 6px;border-bottom:1px solid #1a202c;text-align:right;` +
      `white-space:nowrap;color:${ACCENT}`,
    pill:
      `display:inline-block;border-radius:999px;padding:0 6px;font-size:10px;white-space:nowrap`,
  };
}

/**
 * The HTTP status pill, one finished style per response class: 2xx green, 3xx the panel
 * accent (blue), 4xx amber, 5xx red, and the panel's dim grey when the status is unknown.
 * The dark foreground is shared, so a pill reads the same whichever class it lands in.
 *
 * @param PILL The base pill style from {@link tableStyles}.
 * @param ACCENT The panel accent colour (the 3xx background).
 * @returns The five pill styles, ready to assign as `cssText`.
 */
function statusPillStyles(PILL: string, ACCENT: string) {
  const on = (background: string) => `${PILL};background:${background};color:#0c0e14`;
  return {
    pill2xx: on("#5fd48a"),
    pill3xx: on(ACCENT),
    pill4xx: on("#f0b45b"),
    pill5xx: on("#ff6b6b"),
    pillUnknown: on("#5b647a"),
  };
}

/** Body split, left pane, toolbar, search and icon buttons. */
function layoutStyles(ACCENT: string) {
  return {
    body: `flex:1;display:flex;min-height:0`,
    left:
      `width:46%;display:flex;flex-direction:column;border-right:1px solid #1d2330;min-height:0`,
    toolbar:
      `display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid #1a202c`,
    search: `flex:1;min-width:0;font:inherit;background:#0c0e14;color:#e6e9ef;` +
      `border:1px solid #2a3140;border-radius:5px;padding:2px 6px`,
    icon:
      `background:none;border:1px solid #2a3140;color:#8b94a7;cursor:pointer;border-radius:5px;padding:2px 6px;font:inherit`,
    iconOn: `background:${ACCENT};border:1px solid ${ACCENT};color:#0c0e14;cursor:pointer;` +
      `border-radius:5px;padding:2px 6px;font:inherit`,
    tree: `flex:1;min-height:0;overflow:auto;padding:6px 0`,
    detail: `flex:1;overflow:auto;padding:8px 10px`,
  };
}

/** Component-tree rows and their name/key colors. */
function treeStyles(ACCENT: string) {
  return {
    row: `box-sizing:border-box;width:max-content;min-width:100%;padding:2px 10px;cursor:pointer;` +
      `white-space:nowrap;border-radius:4px;display:flex;align-items:center;gap:3px`,
    rowSel:
      `box-sizing:border-box;width:max-content;min-width:100%;padding:2px 10px;cursor:pointer;` +
      `white-space:nowrap;border-radius:4px;display:flex;align-items:center;gap:3px;background:#233152`,
    twist: `width:11px;flex:0 0 auto;color:#5b647a;text-align:center`,
    comp: `color:${ACCENT}`,
    hostName: `color:#7f8ba3`,
    key: `color:#f0b45b`,
    dim: `color:#5b647a`,
  };
}

/** Detail pane: headings, prop/hook rows, inputs, actions, why-did-you-render list. */
function detailStyles(CHANGED: string) {
  return {
    h4:
      `margin:10px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7`,
    h4First:
      `margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7`,
    kv: `display:flex;gap:6px;padding:1px 0;align-items:baseline`,
    k: `color:#c7a4ff;flex:0 0 auto`,
    kChanged: `color:${CHANGED};flex:0 0 auto;font-weight:600`,
    kHook: `color:#f0b45b;flex:0 0 auto`,
    v: `color:#e6e9ef;word-break:break-all`,
    vExpand: `color:#e6e9ef;word-break:break-all;cursor:pointer`,
    input: `font:inherit;background:#0c0e14;color:#e6e9ef;border:1px solid #2a3140;` +
      `border-radius:4px;padding:1px 4px;max-width:180px`,
    act:
      `background:none;border:0;color:#5b647a;cursor:pointer;font:inherit;padding:0 2px;margin-left:4px`,
    count: `color:${CHANGED};margin-left:6px;font-size:10px`,
    empty: `color:#5b647a;padding:8px 10px`,
    wf: `padding:4px 0;margin:0;list-style:none`,
    wfLi: `display:flex;gap:8px;padding:2px 10px;border-top:1px solid #1a202c;list-style:none`,
    at: `color:#8b94a7;margin-left:auto`,
    // Profiler: commit-bar strip, flamegraph rows/bars, ranked list.
  };
}

/**
 * The Console tab (one row per entry, coloured by level), the launcher's error-count badge,
 * the header's full/half size toggle and the full-viewport panel frame. The toggle and the
 * close button get a 44 px hit area (touch), and the full frame keeps clear of the notch /
 * home indicator through the safe-area insets.
 */
function consoleStyles(ACCENT: string) {
  const row = `padding:3px 8px;border-bottom:1px solid #1a202c;border-left:3px solid `;
  const text = `white-space:pre-wrap;word-break:break-word;cursor:pointer`;
  return {
    cRowError: `${row}#ff6b6b;background:rgba(255,107,107,.08);color:#ffb3b3;${text}`,
    cRowWarn: `${row}#f0b45b;background:rgba(240,180,91,.07);color:#ffe0a6;${text}`,
    cRowInfo: `${row}${ACCENT};color:#d6ddff;${text}`,
    cRowLog: `${row}#2a3140;color:#e6e9ef;${text}`,
    cRowDebug: `${row}#2a3140;color:#8b94a7;${text}`,
    cTime: `color:#5b647a;margin-right:6px;font-size:10px`,
    cSource: `color:#8b94a7;margin-right:6px;font-size:10px`,
    cStack: `margin:4px 0 2px;padding:4px 6px;background:#0c0e14;color:#b9c0cf;` +
      `white-space:pre-wrap;word-break:break-all;font-size:11px;border-radius:4px`,
    cDiag: `padding:6px 8px;border-bottom:1px solid #1a202c;color:${ACCENT};white-space:pre-wrap`,
    cToolbar: `display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:5px 8px;` +
      `border-bottom:1px solid #1a202c;position:sticky;top:0;background:#12151c;z-index:1`,
    cBtn: `background:none;border:1px solid #2a3140;color:#8b94a7;cursor:pointer;` +
      `border-radius:5px;padding:6px 9px;font:inherit;min-height:32px`,
    cBtnOn: `background:${ACCENT};border:1px solid ${ACCENT};color:#0c0e14;cursor:pointer;` +
      `border-radius:5px;padding:6px 9px;font:inherit;min-height:32px`,
    // A sibling of the launcher, not a child: the launcher clips to its circle.
    launchBadge: `position:fixed;left:36px;bottom:36px;z-index:2147483003;min-width:18px;` +
      `height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#ff3b3b;` +
      `color:#fff;font:700 10px/18px ui-monospace,Menlo,monospace;text-align:center;` +
      `cursor:pointer;border:0;box-shadow:0 2px 8px rgba(0,0,0,.5)`,
    // The header's size toggle + close: 26 px glyphs in 44 px square tap targets.
    headBtns: `display:flex;align-items:center;gap:6px;flex:0 0 auto;margin:-6px -4px -6px auto`,
    headBtn: `background:none;border:0;color:#aeb6c7;cursor:pointer;font-size:26px;line-height:1;` +
      `width:44px;height:44px;padding:0;border-radius:8px;flex:0 0 auto;display:flex;` +
      `align-items:center;justify-content:center;touch-action:manipulation`,
    panelHalf: `height:50vh;bottom:max(12px,env(safe-area-inset-bottom,0px))`,
    panelFull: `left:0;top:0;right:0;bottom:0;width:auto;height:auto;border-radius:0;border:0;` +
      `padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ` +
      `env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);box-sizing:border-box`,
  };
}

/** The hover/pick highlight overlay's resting fill. */
const OVERLAY_BG = "rgba(138,162,255,.22)";

/** Profiler commit strip, flamegraph, ranked list, plus the hover overlay + tip. */
function profilerStyles(MONO: string, ACCENT: string) {
  return {
    // Profiler: commit-bar strip, flamegraph rows/bars, ranked list.
    commitStrip: `display:flex;align-items:flex-end;gap:2px;height:56px;padding:6px 2px;` +
      `overflow-x:auto;border-bottom:1px solid #1a202c;margin-bottom:6px`,
    commitBar: `flex:0 0 auto;width:10px;min-height:2px;background:#3a4356;` +
      `border-radius:2px 2px 0 0;cursor:pointer`,
    commitBarSel: `flex:0 0 auto;width:10px;min-height:2px;background:${ACCENT};` +
      `border-radius:2px 2px 0 0;cursor:pointer`,
    flameWrap: `min-width:0`,
    flameBar: `box-sizing:border-box;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;` +
      `font-size:10px;color:#0c0e14;border-radius:2px;padding:1px 3px;margin:1px 0;cursor:pointer`,
    flameRow: `display:flex;width:100%;gap:1px`,
    rank: `display:flex;gap:6px;padding:1px 0;align-items:baseline`,
    rankBar: `height:9px;border-radius:2px;background:${ACCENT};flex:0 0 auto`,
    // Split out so the highlight-updates flash (picker.ts) can restore the overlay's
    // resting colours after tinting it, without re-parsing the style string.
    overlayBg: OVERLAY_BG,
    overlayBorder: ACCENT,
    overlay: `position:fixed;z-index:2147483000;pointer-events:none;background:${OVERLAY_BG};` +
      `border:1px solid ${ACCENT};border-radius:2px;display:none`,
    tip: `position:fixed;z-index:2147483000;pointer-events:none;font:11px/1.3 ${MONO};` +
      `color:#0c0e14;background:${ACCENT};border-radius:4px;padding:1px 5px;display:none`,
  };
}

// Minimal DOM helper — inline style via CSSOM (CSP-safe), text children only (no HTML
// parsing). `attrs` sets real attributes (type/title/id); its `style` key is applied as
// cssText, never as a class.
export function el(
  doc: Document,
  tag: string,
  style: string,
  ...kids: (Node | string)[]
): HTMLElement {
  const node = doc.createElement(tag);
  if (style) node.style.cssText = style;
  for (const kid of kids) node.append(typeof kid === "string" ? doc.createTextNode(kid) : kid);
  return node;
}

/** The style table {@link buildStyles} returns. */
export type PanelStyles = ReturnType<typeof buildStyles>;
