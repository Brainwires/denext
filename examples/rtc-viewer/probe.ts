// `deno task probe`: renders every route in process and checks each is a valid HTML document
// (denext's conformance probe, as `denext doctor` runs it). Prints a JSON summary with `--json`.

import { formatReport, probeApp } from "denext/testing";
import { fromFileUrl } from "@std/path";

const report = await probeApp(fromFileUrl(new URL(".", import.meta.url)));
if (Deno.args.includes("--json")) {
  console.log(JSON.stringify({
    ok: report.ok,
    routes: report.routes.map((r) => ({
      path: r.path,
      status: r.status,
      rendered: r.rendered,
      interactive: r.interactive,
    })),
    report: formatReport(report),
  }));
} else console.log(formatReport(report));
Deno.exit(report.ok ? 0 : 1);
