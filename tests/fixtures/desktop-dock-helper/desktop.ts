// The probe's entry: runDesktop, then the commands e2e.sh writes as `<data>/e2e/cmd-<n>` (`open`,
// `close`, `quit`), each answered with a line in `<data>/e2e/state.log`.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

const resolved = await resolveDesktopCapabilities(config, { base: import.meta.url });
const dir = `${resolved.appDirs.data}/e2e`;
await Deno.mkdir(dir, { recursive: true });
const log = (line: string) => Deno.writeTextFile(`${dir}/state.log`, `${line}\n`, { append: true });
// denext's warnings (a Dock helper that cannot run says why) go to the log too: a GUI launch has no
// terminal.
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  Deno.writeTextFileSync(`${dir}/state.log`, `warn ${args.join(" ")}\n`, { append: true });
  warn(...args);
};
const app = await runDesktop({ importMetaUrl: import.meta.url, ...resolved });
await log(`ready ${Deno.execPath()}`);
// The windows open, logged whenever the count changes (the helper's Quit closes them from outside).
let shown = -1;
setInterval(() => {
  const n = app.windows.list().filter((w) => w.kind !== "panel" && w.visible).length;
  if (n !== shown) void log(`probe-windows ${n}`);
  shown = n;
}, 250);

let next = 1;
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const cmd = (await Deno.readTextFile(`${dir}/cmd-${next}`).catch(() => "")).trim();
    if (cmd === "") return;
    next++;
    if (cmd === "open") {
      const win = app.windows.byKey("probe") ??
        app.windows.open({ url: "/", key: "probe", title: "DockHelperProbe" });
      win.show();
      win.focus();
      await log(`opened visible=${win.visible}`);
    } else if (cmd === "close") {
      app.windows.byKey("probe")?.close();
      await log("closed");
    } else if (cmd === "quit") {
      await log("quitting");
      await app.quit();
    }
  } finally {
    busy = false;
  }
}, 250);
