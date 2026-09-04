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
  const S = {
    ...chromeStyles(MONO, ACCENT),
    ...layoutStyles(ACCENT),
    ...treeStyles(ACCENT),
    ...detailStyles(CHANGED),
    ...profilerStyles(MONO, ACCENT),
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
    close:
      `margin-left:auto;background:none;border:0;color:#8b94a7;cursor:pointer;font-size:15px;line-height:1`,
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
    overlay:
      `position:fixed;z-index:2147483000;pointer-events:none;background:rgba(138,162,255,.22);` +
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
