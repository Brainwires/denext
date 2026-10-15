// `denext dashboard` and `denext dashboard-logs`: registered (the relay hidden), loopback by
// default, and the password read from DASHBOARD_PASSWORD — the environment first, else the
// project's `.env` — and never from an argument (no flag names one).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildRegistry } from "../src/cli/register.ts";
import {
  dashboardCommand,
  dashboardLogsCommand,
  dashboardPassword,
} from "../src/cli/commands/dashboard.ts";

Deno.test("dashboard verbs: registered, the relay hidden, no flag takes a password", () => {
  const reg = buildRegistry();
  assertEquals(reg.get("dashboard")?.name, "dashboard");
  assertEquals(reg.get("dashboard-logs")?.hidden, true);
  for (const verb of [dashboardCommand, dashboardLogsCommand]) {
    assertEquals(verb.loadsModules, false, "neither evaluates project code");
    for (const flag of verb.flags ?? []) {
      assertEquals(/pass|secret|token/i.test(flag.name), false, `${verb.name} --${flag.name}`);
    }
  }
  const host = dashboardCommand.flags?.find((f) => f.name === "host");
  assertEquals(host?.help.includes("default 127.0.0.1"), true);
});

Deno.test("dashboardPassword: the environment first, else the project's .env, else none", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dash_cli_" });
  const before = Deno.env.get("DASHBOARD_PASSWORD");
  try {
    Deno.env.delete("DASHBOARD_PASSWORD");
    assertEquals(await dashboardPassword(dir), null);
    await Deno.writeTextFile(join(dir, ".env"), "OTHER=1\nDASHBOARD_PASSWORD='from the file 1'\n");
    assertEquals(await dashboardPassword(dir), "from the file 1");
    Deno.env.set("DASHBOARD_PASSWORD", "from the environment");
    assertEquals(await dashboardPassword(dir), "from the environment");
  } finally {
    if (before === undefined) Deno.env.delete("DASHBOARD_PASSWORD");
    else Deno.env.set("DASHBOARD_PASSWORD", before);
    await Deno.remove(dir, { recursive: true });
  }
});
