// The probe's entry: runDesktop, then the commands e2e.sh writes as `<data>/e2e/cmd-<n>` (`open`,
// `close`, `quit`), each answered with a line in `<data>/e2e/state.log`.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

const resolved = await resolveDesktopCapabilities(config, {
  base: import.meta.url,
});
const app = await runDesktop({ importMetaUrl: import.meta.url, ...resolved });
const dir = `${resolved.appDirs.data}/e2e`;
await Deno.mkdir(dir, { recursive: true });
const log = (line: string) => Deno.writeTextFile(`${dir}/state.log`, `${line}\n`, { append: true });
await log("ready");

let next = 1;
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const cmd = (await Deno.readTextFile(`${dir}/cmd-${next}`).catch(() => ""))
      .trim();
    if (cmd === "") return;
    next++;
    if (cmd === "open") {
      const win = app.windows.byKey("probe") ??
        app.windows.open({ url: "/", key: "probe", title: "DockHelperProbe" });
      win.show();
      win.focus();
      await log("opened");
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
