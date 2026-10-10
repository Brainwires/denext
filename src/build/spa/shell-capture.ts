// `spa.shell`'s HTML pieces that the shell page (./shared.ts) needs: the rendered parts' shape and
// the inline field-capture script. A leaf module with no imports, so the page builder — which the
// Deno Desktop runtime (src/build/desktop.ts) reaches for `wantsShell` — does not pull the shell
// renderer (./shell.ts, the bundler) into a desktop app's module graph.

/** A rendered shell: the mount element's markup and the inline boot script, if any. */
export interface SpaShellParts {
  /** The component's HTML, placed inside the mount element. */
  readonly markup: string;
  /** The bundled `bootScript` (a classic script's source), inlined before the markup. */
  readonly bootScript?: string;
}

/**
 * The inline script that records each shell field's state into `window.__denextShell` as the user
 * types (`s`: key → `{ text, selectionStart, selectionEnd, focused, scrollTop }`), and exposes
 * `c()` to capture every field at once (the swap's final read). Only fields inside the shell
 * (`[data-denext-shell]`) count, so the app's own keyed fields never overwrite it. A
 * `contenteditable` field's text has a `\n` per `<br>` and per block after the first, and its
 * selection is counted in that text. Plain ES5: it runs before any bundle, in every engine.
 */
export const SHELL_CAPTURE_SCRIPT =
  `(function(){var d=document,A="data-denext-shell-key",g=window.__denextShell={s:{},t:{}};` +
  `function ser(r,n,o){var out="",stop=0;function w(p){for(var c=p.firstChild,i=0;c&&!stop;` +
  `c=c.nextSibling,i++){if(p===n&&i===o){stop=1;return}if(c.nodeType===3){if(c===n){` +
  `out+=c.data.slice(0,o);stop=1;return}out+=c.data}else if(c.nodeName==="BR")out+="\\n";` +
  `else{if(/^(DIV|P|LI|H[1-6])$/.test(c.nodeName)&&out&&out.slice(-1)!=="\\n")out+="\\n";` +
  `w(c)}}if(p===n)stop=1}w(r);return out}` +
  `function rec(el){var a=d.activeElement,v={text:"",selectionStart:0,selectionEnd:0,` +
  `focused:a===el||el.contains(a),scrollTop:el.scrollTop};if(el.tagName==="TEXTAREA"||` +
  `el.tagName==="INPUT"){v.text=el.value;v.selectionStart=el.selectionStart||0;` +
  `v.selectionEnd=el.selectionEnd||0}else{v.text=ser(el);var s=d.getSelection(),` +
  `r=s&&s.rangeCount?s.getRangeAt(0):null;if(r&&el.contains(r.startContainer)&&` +
  `el.contains(r.endContainer)){v.selectionStart=ser(el,r.startContainer,r.startOffset).length;` +
  `v.selectionEnd=ser(el,r.endContainer,r.endOffset).length}else{v.selectionStart=` +
  `v.selectionEnd=v.text.length}}g.s[el.getAttribute(A)]=v}` +
  `function on(e){if(g.d)return;var t=e.target===d?d.activeElement:e.target,` +
  `f=t&&t.closest?t.closest("["+A+"]"):null;if(f&&f.closest("[data-denext-shell]"))rec(f)}` +
  `["input","focusin","focusout","keyup","mouseup","scroll","selectionchange"].forEach(` +
  `function(t){d.addEventListener(t,on,true)});g.c=function(){var l=d.querySelectorAll(` +
  `"[data-denext-shell] ["+A+"]");for(var i=0;i<l.length;i++)rec(l[i]);return g.s}})();`;
