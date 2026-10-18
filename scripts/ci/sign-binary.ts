// The release workflow's (publish.yml) signing step for a `denext` binary it cross-compiled:
// the same code path as `denext build --compile --sign` (src/build/compile-sign.ts), so the
// framework's own binaries are signed exactly as an app's are. Credentials come from the
// `DENEXT_*` environment (src/build/code-signing.ts lists them); never printed.
//
//   deno run -A scripts/ci/sign-binary.ts --target <triple> <binary>
//
// Exits 0 after signing, 1 when signing failed (a missing credential or tool included).

import { resolve } from "@std/path";
import { signCompiledBinary } from "../../src/build/compile-sign.ts";

const at = Deno.args.indexOf("--target");
const target = at >= 0 ? Deno.args[at + 1] : undefined;
const binary = Deno.args.find((a, i) => !a.startsWith("--") && !(at >= 0 && i === at + 1));
if (!binary || !target) {
  console.error("usage: sign-binary.ts --target <triple> <binary>");
  Deno.exit(2);
}
try {
  const result = await signCompiledBinary(resolve(binary), {
    explicit: true,
    target,
    projectDir: Deno.cwd(),
  });
  console.log(`${binary}: ${result?.detail}`);
} catch (err) {
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
  Deno.exit(1);
}
