// The dev console capture: the first thing every dev page runs (it heads the dev-reload
// script on BOTH dev servers — App Router and SPA), so it sees boot failures the app's own
// code never gets the chance to report.
//
// It keeps a bounded in-page buffer of console calls, uncaught errors, unhandled
// rejections and resource/script load failures, exposed as `window.__denextConsole` for
// the DevTools panel's Console tab; forwards each entry (batched) to the dev server's event
// log (`POST /_denext/dev-log`, read back by `denext_dev_logs`); and, when the entry module
// fails to load, walks the module graph from the entry to name the module that broke it —
// browsers don't (Safari: "Importing a module script failed").
//
// The walk is two passes. The static pass follows static imports only — the graph the
// browser must link before a module runs — up to {@linkcode DIAGNOSIS_MODULE_CAP} modules.
// When it finds nothing, the deep pass follows what it skipped: every string-literal dynamic
// `import()` (after the dev transform, `import("./main")` is `import("/_denext/@fs/…")`),
// `new URL("./worker.ts", import.meta.url)` and `import.meta.resolve("./x.js")` script modules,
// and any static edge the cap cut — up to {@linkcode DEEP_DIAGNOSIS_MODULE_CAP}. An app that
// boots through `import("./main").catch(showError)` fails only inside that dynamic graph, and
// reports it with `console.error` rather than an unhandled rejection, so a console error
// carrying an import-failure message starts the walk too. When the browser's message names
// the module (Chrome: "Failed to fetch dynamically imported module: <url>"; Safari doesn't),
// the walk starts there.
//
// Each module the walk fetches is also tokenized (strings, comments, templates and regex
// literals skipped) for what it imports by name and what it exports, `export *` chains
// included, so a link-time failure — an imported name the target does not export, which
// Safari reports only as "Importing a module script failed" — is named with its importer and
// the closest export. A module it can't analyze confidently (CommonJS-looking, a destructuring
// export, an untokenizable literal) is not checked rather than guessed at. The browser's own
// "does not provide an export named" message is surfaced as soon as it is seen.
//
// It also notices a reload loop: when the dev server orders more than
// {@linkcode RELOAD_LOOP_LIMIT} reloads within {@linkcode RELOAD_LOOP_WINDOW_MS} (a rebuild
// that keeps re-triggering itself), it says so in the console instead of staying silent.
//
// Plain ES5-style JavaScript in a string (it ships as-is to every browser, before any
// bundle). Every global it touches is reached through `window` or a guarded free name, so a
// test can evaluate it against fakes without patching the test process's own console.

/** How many entries the in-page buffer keeps (oldest dropped first). */
export const CONSOLE_BUFFER_LIMIT = 500;

/** How many modules the boot diagnosis's static pass fetches at most. */
export const DIAGNOSIS_MODULE_CAP = 400;

/** How many modules one boot diagnosis fetches at most, its deep pass included. */
export const DEEP_DIAGNOSIS_MODULE_CAP = 2000;

/** More dev-server-ordered reloads than this within the window is reported as a loop. */
export const RELOAD_LOOP_LIMIT = 3;

/** The window the reload-loop check counts dev-server-ordered reloads over. */
export const RELOAD_LOOP_WINDOW_MS = 30_000;

/**
 * The capture script, parameterized by the dev-log endpoint it forwards to.
 *
 * @param devLogPath The dev server's browser-log sink (`/_denext/dev-log`).
 * @returns A self-contained script body (an IIFE).
 */
export function consoleCaptureScript(devLogPath: string): string {
  return `
(function () {
  if (window.__denextConsole) return;
  var LIMIT = ${CONSOLE_BUFFER_LIMIT};
  var MODULE_CAP = ${DIAGNOSIS_MODULE_CAP};
  var DEEP_CAP = ${DEEP_DIAGNOSIS_MODULE_CAP};
  var PROGRESS_EVERY = 200;
  var RELOAD_LIMIT = ${RELOAD_LOOP_LIMIT};
  var RELOAD_WINDOW = ${RELOAD_LOOP_WINDOW_MS};
  var RELOAD_LOG = "__denextDevReloads";
  var RELOAD_MARK = "__denextDevReloadMark";
  var SCRIPT_EXT = /\\.(?:m?[jt]sx?|cjs)(?:[?#]|$)/i;
  var URL_IN_MSG = /\\bhttps?:\\/\\/[^\\s'"<>()]+/;
  var CONCURRENCY = 6;
  var MAX_STR = 2000;
  var DEV_LOG = ${JSON.stringify(devLogPath)};
  var LEVELS = ["log", "info", "warn", "error", "debug"];
  var IMPORT_ERR = /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Failed to load module script|does not provide an export named|doesn't provide an export named|Importing binding name|import not found|Cannot find module|does not resolve to a valid URL|Failed to resolve module specifier|disallowed MIME type|MIME type/i;
  var entries = [];
  var seq = 0;
  var subs = [];
  var busy = false; // re-entrancy guard: our own work never captures itself
  var outbox = [];
  var flushTimer = null;
  var notifyTimer = null;
  var autoDiagnosed = false;
  var diag = { state: "idle", checked: 0, queued: 0, failures: [], entry: "", note: "" };
  var con = window.console;
  var orig = {};

  function later(fn, ms) {
    try { return window.setTimeout(fn, ms); } catch (_) { return null; }
  }
  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + "… (" + (s.length - n) + " more chars)" : s;
  }

  // ---- serialization ------------------------------------------------------------------
  function isNode(v) {
    return v && typeof v === "object" && typeof v.nodeType === "number" && typeof v.nodeName === "string";
  }
  function describeNode(n) {
    if (n.nodeType === 3) return "#text " + JSON.stringify(clip(n.nodeValue || "", 80));
    if (n.nodeType === 9) return "#document";
    var tag = String(n.tagName || n.nodeName).toLowerCase();
    var id = n.id ? "#" + n.id : "";
    var cls = typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\\s+/).join(".") : "";
    var src = n.getAttribute && (n.getAttribute("src") || n.getAttribute("href"));
    return "<" + tag + id + cls + (src ? " " + (n.getAttribute("src") ? "src" : "href") + "=" + JSON.stringify(src) : "") + ">";
  }
  function errorText(e) {
    var name = e.name || "Error";
    return name + ": " + (e.message == null ? "" : e.message);
  }
  function fmt(v, depth, seen) {
    var t = typeof v;
    if (v === null) return "null";
    if (t === "undefined") return "undefined";
    if (t === "string") return depth === 0 ? v : JSON.stringify(clip(v, 200));
    if (t === "number" || t === "boolean") return String(v);
    if (t === "bigint") return String(v) + "n";
    if (t === "symbol") return String(v);
    if (t === "function") return "ƒ " + (v.name || "anonymous") + "()";
    if (v instanceof Error || (v && typeof v.message === "string" && typeof v.stack === "string")) return errorText(v);
    if (isNode(v)) return describeNode(v);
    if (seen.indexOf(v) !== -1) return "[Circular]";
    if (depth >= 3) return Array.isArray(v) ? "[Array(" + v.length + ")]" : "{…}";
    seen.push(v);
    var out;
    try {
      if (Array.isArray(v)) {
        var parts = [];
        for (var i = 0; i < v.length && i < 50; i++) parts.push(fmt(v[i], depth + 1, seen));
        if (v.length > 50) parts.push("… " + (v.length - 50) + " more");
        out = "[" + parts.join(", ") + "]";
      } else {
        var keys = Object.keys(v);
        var kv = [];
        for (var k = 0; k < keys.length && k < 50; k++) {
          var val;
          try { val = fmt(v[keys[k]], depth + 1, seen); } catch (_) { val = "[unreadable]"; }
          kv.push(keys[k] + ": " + val);
        }
        if (keys.length > 50) kv.push("… " + (keys.length - 50) + " more");
        var ctor = v.constructor && v.constructor.name;
        out = (ctor && ctor !== "Object" ? ctor + " " : "") + "{" + kv.join(", ") + "}";
      }
    } catch (_) {
      out = "[unserializable]";
    }
    seen.pop();
    return out;
  }
  function format(args) {
    args = Array.prototype.slice.call(args);
    var head = "";
    if (typeof args[0] === "string" && args[0].indexOf("%") !== -1) {
      var rest = args.slice(1);
      head = args[0].replace(/%([sdifoOc%])/g, function (m, c) {
        if (c === "%") return "%";
        if (!rest.length) return m;
        var a = rest.shift();
        if (c === "c") return "";
        if (c === "d" || c === "i") return String(parseInt(a, 10));
        if (c === "f") return String(parseFloat(a));
        return fmt(a, c === "s" ? 0 : 1, []);
      });
      args = rest;
      var tail = [];
      for (var i = 0; i < args.length; i++) tail.push(fmt(args[i], 0, []));
      return clip(tail.length ? head + " " + tail.join(" ") : head, MAX_STR);
    }
    var parts = [];
    for (var j = 0; j < args.length; j++) parts.push(fmt(args[j], 0, []));
    return clip(parts.join(" "), MAX_STR);
  }
  function stackOf(args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a && typeof a === "object" && typeof a.stack === "string" && a.stack) return clip(a.stack, 4000);
    }
    return "";
  }

  // ---- the buffer -----------------------------------------------------------------------
  function notify() {
    if (notifyTimer !== null) return;
    notifyTimer = later(function () {
      notifyTimer = null;
      for (var i = 0; i < subs.length; i++) { try { subs[i](); } catch (_) {} }
    }, 0);
    if (notifyTimer === null) {
      for (var i = 0; i < subs.length; i++) { try { subs[i](); } catch (_) {} }
    }
  }
  function push(level, source, message, stack, url) {
    var entry = {
      id: ++seq,
      ts: Date.now(),
      level: level,
      source: source,
      message: clip(message == null ? "" : message, MAX_STR),
      stack: stack ? clip(stack, 4000) : "",
      url: url || ""
    };
    entries.push(entry);
    if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
    if (level === "error") api.errorCount++;
    forward(entry);
    notify();
    return entry;
  }

  // ---- forwarding to the dev server's event log ----------------------------------------
  function forward(entry) {
    outbox.push({
      level: entry.level,
      message: (entry.source === "console" ? "" : "[" + entry.source + "] ") + entry.message,
      stack: entry.stack,
      url: (typeof location !== "undefined" && location && location.pathname) || ""
    });
    if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
    if (flushTimer === null) flushTimer = later(flush, 250);
  }
  function flush() {
    flushTimer = null;
    if (!outbox.length || typeof window.fetch !== "function") { outbox = []; return; }
    var batch = outbox.splice(0, 50);
    busy = true;
    try {
      var p = window.fetch(DEV_LOG, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        keepalive: true
      });
      if (p && p.catch) p.catch(function () {});
    } catch (_) {
    } finally { busy = false; }
    if (outbox.length) flushTimer = later(flush, 250);
  }

  // ---- console wrapping ----------------------------------------------------------------
  if (con) {
    LEVELS.forEach(function (lvl) {
      var o = con[lvl];
      if (typeof o !== "function") return;
      orig[lvl] = o;
      con[lvl] = function () {
        if (!busy) {
          busy = true;
          try {
            var text = format(arguments);
            push(lvl, "console", text, lvl === "error" || lvl === "warn" ? stackOf(arguments) : "");
            // An app that catches its own boot import (import("./main").catch(show))
            // only ever logs the failure — that has to start the walk too.
            if (lvl === "error" || lvl === "warn") sawImportError(text);
          } catch (_) {}
          busy = false;
        }
        return o.apply(this, arguments);
      };
    });
  }

  // ---- errors --------------------------------------------------------------------------
  function sawImportError(message, filename) {
    var text = String(message || "");
    if (!IMPORT_ERR.test(text)) return;
    api.importErrorSeen = true;
    // A link error (a name the target doesn't export): said at once, and the walk starts
    // at the importer when the browser named it.
    var link = linkErrorIn(text, filename);
    if (link && !api.linkError) {
      api.linkError = link;
      push("error", "diagnosis", linkErrorLine(link), "", link.importer || link.target);
    }
    var named = link ? link.importer : moduleUrlIn(text);
    if (named && !api.importErrorUrl) api.importErrorUrl = named;
    if (!autoDiagnosed) {
      autoDiagnosed = true;
      later(function () { diagnose("import error", named); }, 1200);
    }
  }
  // The same-origin module URL an import error names, when the browser includes one
  // (Chrome / Firefox for a dynamic import; Safari never does).
  function moduleUrlIn(text) {
    var m = URL_IN_MSG.exec(text);
    if (!m) return "";
    var u = m[0].replace(/[.,;:'"]+$/, "");
    return sameOrigin(u) ? new URL(u, location.href).href : "";
  }
  function isModuleScript(t) {
    return t && String(t.tagName || "").toUpperCase() === "SCRIPT" &&
      String((t.getAttribute && t.getAttribute("type")) || t.type || "").toLowerCase() === "module";
  }
  function onError(e) {
    if (!e) return;
    var t = e.target;
    // A resource that failed to load (script, link, img) fires a non-bubbling "error" on
    // the element; the capture phase on window is the only place to see it.
    if (t && t !== window && t.tagName) {
      var src = (t.getAttribute && (t.getAttribute("src") || t.getAttribute("href"))) || "";
      if (isModuleScript(t)) {
        push("error", "resource", "failed to load module script " + src, "", src);
        if (!autoDiagnosed) { autoDiagnosed = true; diagnose("entry script failed to load"); }
      } else {
        push("error", "resource", "failed to load " + describeNode(t), "", src);
      }
      return;
    }
    var err = e.error;
    var msg = err ? errorText(err) : (e.message || "Script error");
    var where = e.filename ? " (" + e.filename + (e.lineno ? ":" + e.lineno + (e.colno ? ":" + e.colno : "") : "") + ")" : "";
    push("error", "uncaught", msg + (err ? "" : where), err && err.stack ? String(err.stack) : "", e.filename || "");
    sawImportError(msg, e.filename);
  }
  function onRejection(e) {
    var r = e && e.reason;
    var msg = r && typeof r === "object" && "message" in r ? errorText(r) : fmt(r, 0, []);
    push("error", "rejection", "Unhandled rejection: " + msg, r && r.stack ? String(r.stack) : "", "");
    sawImportError(msg);
  }
  if (window.addEventListener) {
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
  }

  // ---- boot diagnosis ------------------------------------------------------------------
  function sameOrigin(u) {
    try { return new URL(u, location.href).origin === location.origin; } catch (_) { return false; }
  }
  function findEntry() {
    if (typeof document === "undefined" || !document.querySelectorAll) return "";
    var scripts = document.querySelectorAll("script[type=module][src]");
    var best = "";
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].getAttribute("src");
      if (!s) continue;
      var abs;
      try { abs = new URL(s, location.href).href; } catch (_) { continue; }
      if (!sameOrigin(abs)) continue;
      if (!best || abs.indexOf("/_denext/") !== -1) best = abs;
      if (abs.indexOf("/_denext/") !== -1) break;
    }
    return best;
  }
  function importMapKeys() {
    var keys = [];
    try {
      var maps = document.querySelectorAll("script[type=importmap]");
      for (var i = 0; i < maps.length; i++) {
        var m = JSON.parse(maps[i].textContent || "{}");
        if (m.imports) keys = keys.concat(Object.keys(m.imports));
        if (m.scopes) for (var sc in m.scopes) keys = keys.concat(Object.keys(m.scopes[sc] || {}));
      }
    } catch (_) {}
    return keys;
  }
  function mapped(spec, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === spec || (k.charAt(k.length - 1) === "/" && spec.indexOf(k) === 0)) return true;
    }
    return false;
  }
  function isBare(spec) {
    return !/^(\\.{0,2}\\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(spec);
  }
  // The specifiers a module imports: static import/export-from, side-effect imports, and —
  // marked dynamic — string-literal dynamic imports plus the script modules named by
  // new URL("…", import.meta.url) (a worker) or import.meta.resolve("…"). Statement starts
  // only (line start or after ";"/"}"), and the clause before "from" can't contain a quote,
  // so string contents aren't matched.
  function importsOf(text) {
    var out = [];
    var re = /(?:^|[;}\\n])\\s*(?:import|export)\\s*([\\w$*{}\\s,]*?)\\s*from\\s*(["'])([^"'\\n]+)\\2/g;
    var m;
    while ((m = re.exec(text))) out.push({ spec: m[3], dynamic: false });
    re = /(?:^|[;}\\n])\\s*import\\s*(["'])([^"'\\n]+)\\1/g;
    while ((m = re.exec(text))) out.push({ spec: m[2], dynamic: false });
    re = /\\bimport\\s*\\(\\s*(["'])([^"'\\n]+)\\1\\s*\\)/g;
    while ((m = re.exec(text))) out.push({ spec: m[2], dynamic: true });
    re = /\\bnew\\s+URL\\s*\\(\\s*(["'])([^"'\\n]+)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)/g;
    while ((m = re.exec(text))) if (SCRIPT_EXT.test(m[2])) out.push({ spec: m[2], dynamic: true });
    re = /\\bimport\\.meta\\.resolve\\s*\\(\\s*(["'])([^"'\\n]+)\\1\\s*\\)/g;
    while ((m = re.exec(text))) if (SCRIPT_EXT.test(m[2])) out.push({ spec: m[2], dynamic: true });
    return out;
  }
  var evalOk = null;
  function canEval() {
    if (evalOk === null) {
      try { new Function(""); evalOk = true; } catch (_) { evalOk = false; }
    }
    return evalOk;
  }
  // A best-effort syntax check: the module's import/export syntax rewritten to plain
  // statements, then compiled (never run) as an async function body (top-level await).
  function syntaxError(text) {
    if (!canEval()) return "";
    var body = text
      .replace(/(^|[;}\\n])(\\s*)import\\s*[\\w$*{}\\s,]*?\\s*from\\s*(["'])[^"'\\n]+\\3(\\s*(?:with|assert)\\s*\\{[^}]*\\})?/g, "$1$2void 0")
      .replace(/(^|[;}\\n])(\\s*)import\\s*(["'])[^"'\\n]+\\3(\\s*(?:with|assert)\\s*\\{[^}]*\\})?/g, "$1$2void 0")
      .replace(/(^|[;}\\n])(\\s*)export\\s*[\\w$*{}\\s,]*?\\s*from\\s*(["'])[^"'\\n]+\\3/g, "$1$2void 0")
      .replace(/(^|[;}\\n])(\\s*)export\\s*\\{[^}]*\\}/g, "$1$2void 0")
      .replace(/(^|[;}\\n])(\\s*)export\\s+default\\s+/g, "$1$2void ")
      .replace(/(^|[;}\\n])(\\s*)export\\s+(?=(?:async\\s+)?function|class|const|let|var)/g, "$1$2")
      .replace(/\\bimport\\.meta\\b/g, "({url:''})");
    try {
      var AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      new AsyncFn('"use strict";\\n' + body);
      return "";
    } catch (e) {
      return e && e.name === "SyntaxError" ? String(e.message || e) : "";
    }
  }
  function checkModule(item, keys) {
    var url = item.url;
    return window.fetch(url, { cache: "no-store", credentials: "same-origin" }).then(function (res) {
      var ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
      return res.text().then(function (text) {
        if (!res.ok) return { reason: "HTTP " + res.status + (looksHtml(text) ? " (an HTML page)" : "") };
        if (!/javascript|ecmascript|json|css|wasm/i.test(ct)) {
          return { reason: "served as " + (ct || "no content-type") + ", not JavaScript" +
            (looksHtml(text) ? " — the body is HTML (a fallback page?)" : "") };
        }
        if (!/javascript|ecmascript/i.test(ct)) return { deps: [] };
        var deps = [];
        var specs = importsOf(text);
        for (var i = 0; i < specs.length; i++) {
          var spec = specs[i].spec;
          if (isBare(spec)) {
            if (!specs[i].dynamic && !mapped(spec, keys)) {
              return { reason: "imports the bare specifier " + JSON.stringify(spec) + ", which no import map resolves" };
            }
            continue;
          }
          var abs;
          try { abs = new URL(spec, url).href; } catch (_) { continue; }
          if (sameOrigin(abs)) deps.push({ url: abs, dynamic: specs[i].dynamic });
        }
        var syn = syntaxError(text);
        if (syn) return { reason: "does not parse: " + syn, deps: deps };
        recordLinks(url, text);
        return { deps: deps };
      });
    }, function (err) {
      return { reason: "network error: " + (err && err.message ? err.message : String(err)) };
    });
  }
  function looksHtml(text) {
    return /^\\s*<(!doctype|html|head|body|pre|\\!--)/i.test(String(text).slice(0, 200));
  }

  // ---- the link check: an imported name the target module does not export ----------------
  // A small tokenizer, not regexes over the text: names, strings and the punctuation the
  // import/export grammar needs. Comments, template text, regex literals and numbers are
  // skipped (a template's \${…} is tokenized, as brackets). null when the text does not
  // tokenize (an unterminated literal) — that module is then not checked.
  var REGEX_AFTER = { "return": 1, "typeof": 1, "instanceof": 1, "in": 1, "of": 1, "new": 1, "delete": 1,
    "void": 1, "throw": 1, "case": 1, "do": 1, "else": 1, "yield": 1, "await": 1 };
  var KEEP_PUNCT = "{}()[];,*.";
  var mods = {};     // url -> { own, stars, imports, esm, opaque } for each module the walk analyzed
  var linkSeen = {}; // importer + target + name already reported
  function idChar(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 36 || c === 95 || c === 35 || c === 92 || c >= 128;
  }
  function tokenize(src) {
    var toks = [], i = 0, n = src.length, stack = [], pk = "p", pv = ";";
    function add(k, v) {
      pk = k; pv = v;
      if (k === "n" || k === "s" || (k === "p" && KEEP_PUNCT.indexOf(v) !== -1)) toks.push({ k: k, v: v });
    }
    function regexOk() {
      if (pk === "n") return REGEX_AFTER[pv] === 1;
      return pk === "p" && pv !== ")" && pv !== "]" && pv !== "}";
    }
    function str(q) {
      var s = ++i;
      for (; i < n; i++) {
        var c = src.charCodeAt(i);
        if (c === 92) { i++; continue; }
        if (c === q) { add("s", src.slice(s, i++)); return true; }
        if (c === 10 || c === 13) return false;
      }
      return false;
    }
    function regex() {
      for (var cls = false, c; ++i < n;) {
        c = src.charCodeAt(i);
        if (c === 92) { i++; continue; }
        if (c === 10 || c === 13) return false;
        if (c === 91) cls = true;
        else if (c === 93) cls = false;
        else if (c === 47 && !cls) {
          for (i++; i < n && idChar(src.charCodeAt(i)); i++);
          add("v", "re");
          return true;
        }
      }
      return false;
    }
    function template() { // i: just past a backtick, or past a substitution's closing brace
      for (; i < n; i++) {
        var c = src.charCodeAt(i);
        if (c === 92) { i++; continue; }
        if (c === 96) { i++; add("v", "tpl"); return true; }
        if (c === 36 && src.charCodeAt(i + 1) === 123) { i += 2; stack.push(1); add("p", "("); return true; }
      }
      return false;
    }
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { i = src.indexOf("\\n"); if (i < 0) i = n; }
    while (i < n) {
      var c = src.charCodeAt(i);
      if (c <= 32 || c === 160 || c === 0xfeff || c === 0x2028 || c === 0x2029) { i++; continue; }
      if (c === 47) {
        var d = src.charCodeAt(i + 1);
        if (d === 47) { var nl = src.indexOf("\\n", i); i = nl < 0 ? n : nl; continue; }
        if (d === 42) { var end = src.indexOf("*/", i + 2); if (end < 0) return null; i = end + 2; continue; }
        if (regexOk()) { if (!regex()) return null; continue; }
        i++; add("p", "/"); continue;
      }
      if (c === 34 || c === 39) { if (!str(c)) return null; continue; }
      if (c === 96) { i++; if (!template()) return null; continue; }
      if (idChar(c)) {
        var s = i;
        while (i < n && idChar(src.charCodeAt(i))) i++;
        if (c >= 48 && c <= 57) add("v", "num"); else add("n", src.slice(s, i));
        continue;
      }
      i++;
      // a++ / b: a postfix ++ / -- ends an operand, so the slash after it divides
      if ((c === 43 || c === 45) && src.charCodeAt(i) === c) { i++; add("v", "++"); continue; }
      if (c === 123) stack.push(0);
      else if (c === 125 && stack.pop() === 1) { add("p", ")"); if (!template()) return null; continue; }
      add("p", String.fromCharCode(c));
    }
    return toks;
  }
  function is(t, v) { return !!t && t.k === "p" && t.v === v; }
  function isN(t, v) { return !!t && t.k === "n" && t.v === v; }
  function fromSpec(t, j) { return isN(t[j], "from") && t[j + 1] && t[j + 1].k === "s" ? t[j + 1].v : null; }
  // { a, b as c, "d" as e } from t[j] (the brace): [local, exported] pairs; the index past
  // the closing brace, or -1.
  function nameList(t, j, pairs) {
    for (j++; j < t.length && !is(t[j], "}");) {
      var a = t[j].v, b = a;
      j++;
      if (isN(t[j], "as") && t[j + 1] && !is(t[j + 1], "}") && !is(t[j + 1], ",")) { b = t[j + 1].v; j += 2; }
      pairs.push([a, b]);
      if (is(t[j], ",")) j++;
    }
    return j < t.length ? j + 1 : -1;
  }
  // export const|let|var a = …, b = …: every declarator's name. false for a destructuring
  // pattern (not analyzed). Over-collecting a name is safe (it can only hide a report).
  function declared(t, j, own) {
    for (var depth = 0, want = true; j < t.length; j++) {
      var x = t[j];
      if (want) { if (x.k !== "n") return false; own[x.v] = true; want = false; continue; }
      if (x.k !== "p") {
        if (!depth && x.k === "n" && (x.v === "import" || x.v === "export") && !is(t[j - 1], ".")) break;
        continue;
      }
      if (x.v === "{" || x.v === "(" || x.v === "[") depth++;
      else if (x.v === "}" || x.v === ")" || x.v === "]") { if (!depth) break; depth--; }
      else if (!depth && x.v === ";") break;
      else if (!depth && x.v === ",") want = true;
    }
    return true;
  }
  // What a module imports by name (per specifier) and what it exports: its own names, its
  // export-star specifiers. opaque when an export statement isn't understood, or the module
  // looks like CommonJS — its export set is then not trusted.
  function linkInfo(text) {
    var t = tokenize(text);
    if (!t) return null;
    var info = { own: Object.create(null), stars: [], imports: [], esm: false, opaque: false };
    for (var i = 0, depth = 0; i < t.length; i++) {
      var x = t[i];
      if (x.k === "p") {
        if (x.v === "{" || x.v === "(" || x.v === "[") depth++;
        else if (x.v === "}" || x.v === ")" || x.v === "]") depth--;
        continue;
      }
      if (depth || x.k !== "n" || (x.v !== "import" && x.v !== "export") || is(t[i - 1], ".")) continue;
      var j = i + 1, y = t[j], spec, pairs = [], p;
      if (!y) break;
      if (x.v === "import") {
        if (is(y, "(") || is(y, ".")) continue; // import(…), import.meta
        info.esm = true;
        var wanted = [];
        if (y.k === "n") { wanted.push("default"); j++; if (is(t[j], ",")) j++; }
        if (is(t[j], "*")) j += 3; // * as ns: nothing to check
        else if (is(t[j], "{")) {
          if ((j = nameList(t, j, pairs)) < 0) continue;
          for (p = 0; p < pairs.length; p++) wanted.push(pairs[p][0]);
        }
        if ((spec = fromSpec(t, j)) !== null) { info.imports.push({ spec: spec, names: wanted }); i = j + 1; }
        continue;
      }
      info.esm = true;
      if (isN(y, "default")) { info.own["default"] = true; continue; }
      if (is(y, "*")) {
        var ns = isN(t[j + 1], "as") ? t[j + 2] : null;
        j += ns ? 3 : 1;
        if ((spec = fromSpec(t, j)) === null) { info.opaque = true; continue; }
        if (ns) info.own[ns.v] = true; else info.stars.push(spec);
        i = j + 1;
        continue;
      }
      if (is(y, "{")) {
        if ((j = nameList(t, j, pairs)) < 0) { info.opaque = true; continue; }
        var reexported = [];
        for (p = 0; p < pairs.length; p++) { info.own[pairs[p][1]] = true; reexported.push(pairs[p][0]); }
        if ((spec = fromSpec(t, j)) !== null) { info.imports.push({ spec: spec, names: reexported }); i = j + 1; }
        else i = j - 1;
        continue;
      }
      if (isN(y, "async")) y = t[++j];
      if (isN(y, "function") || isN(y, "class")) {
        if (is(t[j + 1], "*")) j++;
        if (t[j + 1] && t[j + 1].k === "n") info.own[t[j + 1].v] = true; else info.opaque = true;
        continue;
      }
      if (isN(y, "const") || isN(y, "let") || isN(y, "var")) {
        if (!declared(t, j + 1, info.own)) info.opaque = true;
        continue;
      }
      info.opaque = true;
    }
    if (!info.esm && /\\b(?:module\\.exports|exports\\.[\\w$]|require\\s*\\()/.test(text)) info.opaque = true;
    return info;
  }
  function linkTarget(spec, base) {
    if (isBare(spec)) return "";
    try { var u = new URL(spec, base).href; return sameOrigin(u) ? u : ""; } catch (_) { return ""; }
  }
  function recordLinks(url, text) {
    var info = linkInfo(text);
    if (!info) return;
    for (var i = 0; i < info.imports.length; i++) info.imports[i].url = linkTarget(info.imports[i].spec, url);
    for (var s = 0; s < info.stars.length; s++) info.stars[s] = linkTarget(info.stars[s], url);
    mods[url] = info;
  }
  // A module's export names: its own, plus (default aside) those of every module its
  // export-star chain reaches — a cycle-safe closure, bounded, cached per check. null when a
  // module on the way wasn't fetched, isn't analyzable or the chain is too long.
  var STAR_CAP = 200;
  var exportCache = {};
  function exportsOf(url) {
    if (url in exportCache) return exportCache[url];
    var out = Object.create(null), seen = {}, stack = [url], count = 0;
    while (stack.length) {
      var u = stack.pop();
      if (seen[u]) continue;
      seen[u] = true;
      var m = mods[u];
      if (!m || m.opaque || ++count > STAR_CAP) return (exportCache[url] = null);
      for (var name in m.own) if (u === url || name !== "default") out[name] = true;
      for (var s = 0; s < m.stars.length; s++) {
        if (!m.stars[s]) return (exportCache[url] = null);
        stack.push(m.stars[s]);
      }
    }
    return (exportCache[url] = out);
  }
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) >= max) return max;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev.push(j);
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  // The closest export by edit distance (a case-only difference counts as 0), when close.
  function closestExport(name, ex) {
    var best = "", bestD = Math.max(2, Math.floor(name.length / 3)) + 1, seen = 0;
    for (var c in ex) {
      if (++seen > 500) break;
      if (c.length > 64) continue;
      var d = c.toLowerCase() === name.toLowerCase() ? 0 : editDistance(name, c, bestD);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  }
  // Every analyzed import edge whose name the target does not export (each reported once).
  function linkCheck() {
    exportCache = {};
    for (var u in mods) {
      var imports = mods[u].imports;
      for (var i = 0; i < imports.length; i++) {
        var im = imports[i];
        var ex = im.url ? exportsOf(im.url) : null;
        if (!ex) continue;
        for (var k = 0; k < im.names.length; k++) {
          var name = im.names[k], key = u + "\\n" + im.url + "\\n" + name;
          if (name in ex || linkSeen[key]) continue;
          linkSeen[key] = true;
          var hint = closestExport(name, ex);
          diag.failures.push({ url: im.url, from: u, missing: name, hint: hint,
            reason: "does not export " + JSON.stringify(name) + (hint ? " (did you mean " + JSON.stringify(hint) + "?)" : "") });
        }
      }
    }
  }
  // The browser's own link error, when it says which name: Chrome / Firefox name the
  // specifier and the name (and an uncaught error's filename is the importer); Safari 17+
  // names only the binding; older Safari says nothing more than "Importing a module script failed".
  var LINK_ERR = /requested module ['"]([^'"]+)['"] (?:does not|doesn't) provide an export named:? ?['"]?([^'"\\s]+)/i;
  var LINK_ERR_NAME = /(?:Importing binding name|import not found:) ?['"]?([^'"\\s]+)/i;
  function linkErrorIn(text, filename) {
    var m = LINK_ERR.exec(text), spec = "", name;
    if (m) { spec = m[1]; name = m[2]; }
    else if ((m = LINK_ERR_NAME.exec(text))) name = m[1];
    else return null;
    var importer = filename && sameOrigin(filename) ? new URL(filename, location.href).href : "";
    var target = spec && (importer || !/^\\.{1,2}\\//.test(spec)) ? linkTarget(spec, importer || location.href) : "";
    return { name: name, spec: spec, importer: importer, target: target };
  }
  function linkErrorLine(le) {
    return "boot diagnosis: the browser reports that " + (le.importer || "a module") + " imports " +
      JSON.stringify(le.name) + " from " + (le.target || le.spec || "a module") + ", which does not export it";
  }
  // A browser link error that named no importer: the walked edge it must be, when exactly one fits.
  function placeLinkError(le) {
    var found = [];
    for (var u in mods) {
      var imports = mods[u].imports;
      for (var i = 0; i < imports.length; i++) {
        var im = imports[i];
        if (im.names.indexOf(le.name) === -1) continue;
        if (le.spec ? im.spec === le.spec || (le.target && im.url === le.target) : true) found.push({ from: u, url: im.url || im.spec });
      }
    }
    if (found.length !== 1) return;
    le.importer = found[0].from;
    le.target = le.target || found[0].url;
    for (var f = 0; f < diag.failures.length; f++) {
      if (diag.failures[f].from === le.importer && diag.failures[f].missing === le.name) return;
    }
    push("error", "diagnosis", linkErrorLine(le), "", le.importer);
  }
  var running = null;
  // Two passes over one seen-set: static imports first (cap MODULE_CAP); if that finds
  // nothing, the edges it skipped — dynamic ones, and static ones past the cap — up to DEEP_CAP.
  function diagnose(why, named) {
    if (running) return running;
    var entry = findEntry();
    named = named && sameOrigin(named) ? named : "";
    if ((!entry && !named) || typeof window.fetch !== "function") {
      diag = { state: "done", checked: 0, queued: 0, failures: [], entry: "", note: "no same-origin module entry script to walk" };
      notify();
      return Promise.resolve(diag);
    }
    var keys = importMapKeys();
    var roots = named && named !== entry ? [named] : [];
    if (entry) roots.push(entry);
    why = why || "manual";
    diag = { state: "running", pass: "static", checked: 0, queued: roots.length, failures: [], entry: entry || named, named: named, note: why, capped: false };
    push("info", "diagnosis", "boot diagnosis: walking the module graph from " + roots.join(" and ") + " (" + why + ")", "", diag.entry);
    var seen = {};
    mods = {};
    linkSeen = {};
    var queue = [];
    var skipped = []; // edges the static pass did not follow: dynamic, or past its cap
    for (var r = 0; r < roots.length; r++) { seen[roots[r]] = true; queue.push({ url: roots[r], from: "" }); }
    var active = 0;
    var cap = MODULE_CAP;
    var progressAt = PROGRESS_EVERY;
    function follow(dep, from) {
      if (seen[dep.url]) return;
      if (diag.pass === "static" && dep.dynamic) { skipped.push({ url: dep.url, from: from }); return; }
      if (diag.checked + queue.length + active >= cap) {
        diag.capped = true;
        if (diag.pass === "static") skipped.push({ url: dep.url, from: from });
        return;
      }
      seen[dep.url] = true;
      queue.push({ url: dep.url, from: from });
    }
    running = new Promise(function (resolve) {
      function finish() {
        diag.state = "done";
        running = null;
        report();
        notify();
        resolve(diag);
      }
      function deepen() {
        diag.pass = "deep";
        diag.staticChecked = diag.checked;
        diag.capped = false;
        cap = DEEP_CAP;
        push("info", "diagnosis", "boot diagnosis: the static import graph (" + diag.checked +
          " module(s)) loads — following dynamic imports too, up to " + DEEP_CAP + " modules", "", diag.entry);
        for (var i = 0; i < skipped.length; i++) follow(skipped[i], skipped[i].from);
        skipped = [];
      }
      function settled() {
        if (queue.length || active) return pump();
        linkCheck();
        if (diag.pass === "static" && !diag.failures.length && skipped.length) {
          deepen();
          if (queue.length) return pump();
        }
        finish();
      }
      function pump() {
        while (active < CONCURRENCY && queue.length) {
          (function (item) {
            active++;
            checkModule(item, keys).then(function (r) {
              active--; // counted in checked from here, so the cap check sees it once
              diag.checked++;
              if (r.reason) diag.failures.push({ url: item.url, from: item.from, reason: r.reason });
              var deps = r.deps || [];
              for (var i = 0; i < deps.length; i++) follow(deps[i], item.url);
            }, function () { active--; diag.checked++; }).then(function () {
              diag.queued = queue.length + active;
              if (diag.pass === "deep" && diag.checked >= progressAt) {
                progressAt += PROGRESS_EVERY;
                push("info", "diagnosis", "boot diagnosis: " + diag.checked + " module(s) checked, " + diag.queued + " pending (deep pass)", "", diag.entry);
              }
              notify();
              settled();
            });
          })(queue.shift());
        }
      }
      pump();
    });
    notify();
    return running;
  }
  function report() {
    var f = diag.failures;
    for (var i = 0; i < f.length && i < 10; i++) {
      if (f[i].missing != null) {
        push("error", "diagnosis", "boot diagnosis: " + f[i].from + " imports " + JSON.stringify(f[i].missing) +
          " from " + f[i].url + ", which does not export it" +
          (f[i].hint ? " — did you mean " + JSON.stringify(f[i].hint) + "?" : ""), "", f[i].from);
        continue;
      }
      push("error", "diagnosis", "boot diagnosis: " + f[i].url + " — " + f[i].reason +
        (f[i].from ? " (imported by " + f[i].from + ")"
          : f[i].url === diag.named ? " (the module the browser's import error names)" : " (the entry module)"), "", f[i].url);
    }
    if (api.linkError && !api.linkError.importer) placeLinkError(api.linkError);
    if (!f.length) {
      push("info", "diagnosis", "boot diagnosis: " + diag.checked + " module(s) checked" +
        (diag.pass === "deep" ? " (static imports, then dynamic ones)" : "") + ", every one served as JavaScript" +
        (canEval() ? " and parsed" : " (the parse check is off: the page's CSP blocks eval)") +
        ", every analyzable import naming an export the target has" +
        (diag.capped ? "; stopped at " + (diag.pass === "deep" ? DEEP_CAP : MODULE_CAP) + " modules" : "") +
        ". The failure is likely a runtime error while a module evaluated — see the errors above.", "", diag.entry);
    }
    showFallback();
  }

  // ---- a fallback list when the DevTools panel never mounted ---------------------------
  var fallback = null;
  function showFallback() {
    later(function () {
      if (window.__denextDevtoolsMounted || typeof document === "undefined" || !document.createElement) return;
      try {
        if (fallback) fallback.remove();
        fallback = document.createElement("div");
        fallback.setAttribute("style", "position:fixed;left:0;right:0;bottom:0;max-height:60vh;overflow:auto;" +
          "z-index:2147483646;background:#12151c;color:#e6e9ef;font:12px/1.45 ui-monospace,Menlo,monospace;" +
          "border-top:2px solid #ff6b6b;padding:10px 12px;-webkit-overflow-scrolling:touch;white-space:pre-wrap;word-break:break-word");
        var close = document.createElement("button");
        close.setAttribute("style", "float:right;background:none;border:0;color:#8b94a7;font-size:22px;line-height:1;padding:4px 8px");
        close.textContent = "×";
        close.onclick = function () { fallback.remove(); fallback = null; };
        fallback.appendChild(close);
        var title = document.createElement("div");
        title.setAttribute("style", "color:#ff6b6b;font-weight:700;margin-bottom:6px");
        title.textContent = "denext — the app failed to boot (console)";
        fallback.appendChild(title);
        var shown = entries.filter(function (e) { return e.level === "error" || e.level === "warn" || e.source === "diagnosis"; }).slice(-40);
        for (var i = 0; i < shown.length; i++) {
          var row = document.createElement("div");
          var c = shown[i].level === "error" ? "#ff8a8a" : shown[i].level === "warn" ? "#ffd27a" : "#8aa2ff";
          row.setAttribute("style", "color:" + c + ";border-bottom:1px solid #2a3140;padding:4px 0");
          row.textContent = shown[i].message + (shown[i].stack ? "\\n" + shown[i].stack : "");
          fallback.appendChild(row);
        }
        (document.body || document.documentElement).appendChild(fallback);
      } catch (_) {}
    }, 1500);
  }

  // ---- reload loop -----------------------------------------------------------------------
  // The dev-reload script marks a reload it orders (markReload) in sessionStorage; the
  // next page load counts it. More than RELOAD_LIMIT within RELOAD_WINDOW is a loop.
  function sessionStore() {
    try { return window.sessionStorage || null; } catch (_) { return null; }
  }
  function markReload(why) {
    var store = sessionStore();
    if (!store) return;
    try { store.setItem(RELOAD_MARK, String(why || "dev reload")); } catch (_) {}
  }
  function checkReloadLoop() {
    var store = sessionStore();
    if (!store) return;
    try {
      var why = store.getItem(RELOAD_MARK);
      if (why === null) return;
      store.removeItem(RELOAD_MARK);
      var now = Date.now();
      var log;
      try { log = JSON.parse(store.getItem(RELOAD_LOG) || "[]"); } catch (_) { log = []; }
      if (!Array.isArray(log)) log = [];
      log = log.filter(function (e) { return e && typeof e.t === "number" && now - e.t < RELOAD_WINDOW && e.t <= now; });
      log.push({ t: now, why: why });
      store.setItem(RELOAD_LOG, JSON.stringify(log.slice(-50)));
      if (log.length <= RELOAD_LIMIT) return;
      var reasons = [];
      for (var i = 0; i < log.length; i++) if (reasons.indexOf(log[i].why) === -1) reasons.push(log[i].why);
      api.reloadLoop = { count: log.length, windowMs: RELOAD_WINDOW, reasons: reasons };
      push("warn", "reload-loop", "dev reload loop: the dev server reloaded this page " + log.length +
        " times in the last " + Math.round(RELOAD_WINDOW / 1000) + " s (" + reasons.join("; ") + "). " +
        "A rebuild that keeps re-triggering itself — an npm dependency re-bundled on every load, or a " +
        "file the build writes inside the watched tree — reloads the page forever; the dev server's " +
        "terminal (or denext_dev_logs) shows what rebuilt.", "", "");
    } catch (_) {}
  }

  var api = {
    entries: entries,
    errorCount: 0,
    importErrorSeen: false,
    importErrorUrl: "",
    linkError: null,
    reloadLoop: null,
    limit: LIMIT,
    get diagnosis() { return diag; },
    subscribe: function (fn) {
      subs.push(fn);
      return function () { var i = subs.indexOf(fn); if (i !== -1) subs.splice(i, 1); };
    },
    clear: function () { entries.length = 0; api.errorCount = 0; notify(); },
    diagnose: diagnose,
    format: format,
    importsOf: importsOf,
    linkInfo: linkInfo,
    markReload: markReload,
    push: push,
    flush: flush
  };
  window.__denextConsole = api;
  checkReloadLoop();
})();
`;
}
