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
// Plain ES5-style JavaScript in a string (it ships as-is to every browser, before any
// bundle). Every global it touches is reached through `window` or a guarded free name, so a
// test can evaluate it against fakes without patching the test process's own console.

/** How many entries the in-page buffer keeps (oldest dropped first). */
export const CONSOLE_BUFFER_LIMIT = 500;

/** How many modules one boot diagnosis fetches at most. */
const DIAGNOSIS_MODULE_CAP = 400;

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
  var CONCURRENCY = 6;
  var MAX_STR = 2000;
  var DEV_LOG = ${JSON.stringify(devLogPath)};
  var LEVELS = ["log", "info", "warn", "error", "debug"];
  var IMPORT_ERR = /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Failed to load module script|does not provide an export named|Cannot find module|does not resolve to a valid URL|Failed to resolve module specifier|disallowed MIME type|MIME type/i;
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
          try { push(lvl, "console", format(arguments), lvl === "error" || lvl === "warn" ? stackOf(arguments) : ""); } catch (_) {}
          busy = false;
        }
        return o.apply(this, arguments);
      };
    });
  }

  // ---- errors --------------------------------------------------------------------------
  function sawImportError(message) {
    if (!IMPORT_ERR.test(String(message || ""))) return;
    api.importErrorSeen = true;
    if (!autoDiagnosed) {
      autoDiagnosed = true;
      later(function () { diagnose("import error"); }, 1200);
    }
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
    sawImportError(msg);
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
  // The specifiers a module imports: static import/export-from, side-effect imports, and
  // string-literal dynamic imports. Statement starts only (line start or after ";"/"}"),
  // and the clause before "from" can't contain a quote, so string contents aren't matched.
  function importsOf(text) {
    var out = [];
    var re = /(?:^|[;}\\n])\\s*(?:import|export)\\s*([\\w$*{}\\s,]*?)\\s*from\\s*(["'])([^"'\\n]+)\\2/g;
    var m;
    while ((m = re.exec(text))) out.push({ spec: m[3], dynamic: false });
    re = /(?:^|[;}\\n])\\s*import\\s*(["'])([^"'\\n]+)\\1/g;
    while ((m = re.exec(text))) out.push({ spec: m[2], dynamic: false });
    re = /\\bimport\\s*\\(\\s*(["'])([^"'\\n]+)\\1\\s*\\)/g;
    while ((m = re.exec(text))) out.push({ spec: m[2], dynamic: true });
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
          if (sameOrigin(abs)) deps.push(abs);
        }
        var syn = syntaxError(text);
        if (syn) return { reason: "does not parse: " + syn, deps: deps };
        return { deps: deps };
      });
    }, function (err) {
      return { reason: "network error: " + (err && err.message ? err.message : String(err)) };
    });
  }
  function looksHtml(text) {
    return /^\\s*<(!doctype|html|head|body|pre|\\!--)/i.test(String(text).slice(0, 200));
  }
  var running = null;
  function diagnose(why) {
    if (running) return running;
    var entry = findEntry();
    if (!entry || typeof window.fetch !== "function") {
      diag = { state: "done", checked: 0, queued: 0, failures: [], entry: "", note: "no same-origin module entry script to walk" };
      notify();
      return Promise.resolve(diag);
    }
    var keys = importMapKeys();
    diag = { state: "running", checked: 0, queued: 1, failures: [], entry: entry, note: why || "manual", capped: false };
    push("info", "diagnosis", "boot diagnosis: walking the module graph from " + entry + " (" + (why || "manual") + ")", "", entry);
    var seen = {};
    seen[entry] = true;
    var queue = [{ url: entry, from: "" }];
    var active = 0;
    running = new Promise(function (resolve) {
      function finish() {
        diag.state = "done";
        running = null;
        report();
        notify();
        resolve(diag);
      }
      function pump() {
        while (active < CONCURRENCY && queue.length) {
          (function (item) {
            active++;
            checkModule(item, keys).then(function (r) {
              diag.checked++;
              if (r.reason) diag.failures.push({ url: item.url, from: item.from, reason: r.reason });
              var deps = r.deps || [];
              for (var i = 0; i < deps.length; i++) {
                if (seen[deps[i]]) continue;
                if (diag.checked + queue.length + active >= MODULE_CAP) { diag.capped = true; break; }
                seen[deps[i]] = true;
                queue.push({ url: deps[i], from: item.url });
              }
            }, function () { diag.checked++; }).then(function () {
              active--;
              diag.queued = queue.length + active;
              notify();
              if (!queue.length && !active) finish(); else pump();
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
      push("error", "diagnosis", "boot diagnosis: " + f[i].url + " — " + f[i].reason +
        (f[i].from ? " (imported by " + f[i].from + ")" : " (the entry module)"), "", f[i].url);
    }
    if (!f.length) {
      push("info", "diagnosis", "boot diagnosis: " + diag.checked + " module(s) checked, every one served as JavaScript" +
        (canEval() ? " and parsed" : " (the parse check is off: the page's CSP blocks eval)") +
        (diag.capped ? "; stopped at " + MODULE_CAP + " modules" : "") +
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

  var api = {
    entries: entries,
    errorCount: 0,
    importErrorSeen: false,
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
    push: push,
    flush: flush
  };
  window.__denextConsole = api;
})();
`;
}
