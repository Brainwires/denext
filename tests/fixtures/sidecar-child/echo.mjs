// A module sidecar that starts a child of itself (tests/desktop-sidecar-child.test.ts). The child
// echoes its stdin to stdout with its argv and exits with the code its second argument names; the
// sidecar reports what came back.
import process from "node:process";

const sc = globalThis.denextSidecar;
if (sc.child) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => input += d);
  process.stdin.on("end", () => {
    const seen = {
      name: sc.name,
      argv: process.argv.slice(2),
      input,
      mode: process.env.MODE ?? null,
      marker: process.env.DENEXT_SIDECAR_CHILD ?? null,
      secrets: Object.keys(sc.secrets),
    };
    process.stdout.write(JSON.stringify(seen) + "\n");
    process.exitCode = Number(process.argv[3] ?? 0);
  });
} else {
  const child = sc.spawnSelf(["echo", "7", "--flag"]);
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out += d);
  child.stderr.on("data", (d) => err += d);
  child.stdin.end("ping\n");
  child.on("close", (code) => {
    console.log("RESULT " + JSON.stringify({ code, out, err: err.slice(-2000) }));
    sc.ready();
  });
}
