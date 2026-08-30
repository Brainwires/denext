// Feasibility probe: do an app's server-only Node dependencies LOAD under Deno's
// node: compatibility layer? Each package is imported in isolation; a failure to
// import (top-level Node-API incompatibility) is the first, cheapest thing that
// would block a denext conversion. Loading is necessary-but-not-sufficient — it
// proves module init works, not that every runtime code path (raw TCP/TLS sockets,
// native addons) behaves — but a clean load clears the biggest hurdle.
//
// Usage:
//   deno run -A --node-modules-dir=auto examples/next-compat-feasibility/probe-server.ts
//
// Edit PACKAGES to match the target app's server dependencies (name@version).

const PACKAGES = [
  "stripe@22.3.0",
  "twilio@5.13.1",
  "openai@6.42.0",
  "@aws-sdk/client-s3@3.1034.0",
  "nodemailer@9.0.3",
  "imapflow@1.3.1",
  "mailparser@3.9.8",
  "jose@5.10.0",
  "bcryptjs@3.0.3",
  "web-push@3.6.7",
  "tar@7.5.13",
  "@simplewebauthn/server@13.3.1",
];

let ok = 0;
for (const pkg of PACKAGES) {
  try {
    const mod = await import(`npm:${pkg}`);
    console.log(`OK    ${pkg.padEnd(34)} (${Object.keys(mod).length} exports)`);
    ok++;
  } catch (e) {
    console.log(
      `FAIL  ${pkg.padEnd(34)} :: ${String((e as Error).message).split("\n")[0].slice(0, 100)}`,
    );
  }
}
console.log(
  `\n${ok}/${PACKAGES.length} server deps load under Deno's node: compat.`,
);
