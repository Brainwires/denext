// repairAdhocSignature: recomputes the stale page hashes of an ad-hoc signed Mach-O (what kills
// the Bun-compiled Tailwind standalone binary on Apple Silicon), and leaves everything else alone.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { repairAdhocSignature } from "../src/build/macho-adhoc.ts";
import { machoFixture } from "./helpers/macho-fixture.ts";

Deno.test("repairAdhocSignature: a stale last-page hash is recomputed; only the slot changes", async () => {
  const good = await machoFixture();
  const broken = await machoFixture({ stale: [good.pages - 1] });
  const before = broken.bytes.slice();
  const repaired = await repairAdhocSignature(broken.bytes);
  assert(repaired, "expected a repair");
  assertEquals(repaired, good.bytes);
  assertEquals(broken.bytes, before, "the input is not modified");
  assertEquals(await repairAdhocSignature(repaired), null, "a repaired binary is consistent");
});

Deno.test("repairAdhocSignature: a consistent signature needs nothing", async () => {
  assertEquals(await repairAdhocSignature((await machoFixture()).bytes), null);
});

Deno.test("repairAdhocSignature: every hash type, and alternate code directories", async () => {
  const types = [1, 2, 3, 4];
  const good = await machoFixture({ hashTypes: types });
  const broken = await machoFixture({ hashTypes: types, stale: [0, 2] });
  assertNotEquals(broken.bytes, good.bytes);
  assertEquals(await repairAdhocSignature(broken.bytes), good.bytes);
});

Deno.test("repairAdhocSignature: a single-page code directory (page size 0) covers the code limit", async () => {
  const fixture = await machoFixture({ codeBytes: 4096 - 7, stale: [0] });
  const cd = fixture.slots[0] - 48;
  const view = new DataView(fixture.bytes.buffer);
  view.setUint8(cd + 39, 0); // pageSize 0: one page, the whole limit
  const repaired = await repairAdhocSignature(fixture.bytes);
  assert(repaired);
  assertEquals(await repairAdhocSignature(repaired), null);
});

Deno.test("repairAdhocSignature: a signature with an identity is not touched", async () => {
  const broken = await machoFixture({ flags: 0x10000, stale: [1] }); // hardened runtime, not ad-hoc
  assertEquals(await repairAdhocSignature(broken.bytes), null);
});

Deno.test("repairAdhocSignature: an unknown hash type is not touched", async () => {
  assertEquals(await repairAdhocSignature((await machoFixture({ hashTypes: [9] })).bytes), null);
});

Deno.test("repairAdhocSignature: anything not a signed thin 64-bit Mach-O is returned as null", async () => {
  const enc = new TextEncoder();
  assertEquals(await repairAdhocSignature(enc.encode("#!/bin/sh\necho hi\n")), null);
  assertEquals(await repairAdhocSignature(new Uint8Array(8)), null);
  // A universal (fat) header.
  assertEquals(
    await repairAdhocSignature(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, ...new Array(60).fill(0)])),
    null,
  );

  const malformed = async (edit: (view: DataView, bytes: Uint8Array) => void) => {
    const { bytes } = await machoFixture({ stale: [0] });
    edit(new DataView(bytes.buffer), bytes);
    return repairAdhocSignature(bytes);
  };
  // No LC_CODE_SIGNATURE (another load command in its place).
  assertEquals(await malformed((v) => v.setUint32(32, 0x19, true)), null);
  // A load command claiming fewer than 8 bytes.
  assertEquals(
    await malformed((v) => {
      v.setUint32(32, 0x19, true);
      v.setUint32(36, 4, true);
    }),
    null,
  );
  // The signature's offset is past the end of the file.
  assertEquals(await malformed((v, b) => v.setUint32(40, b.byteLength, true)), null);
  // The super blob's magic is wrong.
  assertEquals(await malformed((v) => v.setUint32(3 * 4096 + 100, 0)), null);
  // Its index claims more entries than it holds: the ones that fit are still read.
  assert(await malformed((v) => v.setUint32(3 * 4096 + 100 + 8, 1000)));
  // The code directory's slots run past the end of the file.
  assertEquals(await malformed((v) => v.setUint32(3 * 4096 + 100 + 20 + 28, 1 << 24)), null);
  // Its code limit is past the end of the file.
  assertEquals(
    await malformed((v, b) => v.setUint32(3 * 4096 + 100 + 20 + 32, b.byteLength + 1)),
    null,
  );
  // A blob in the index that is not a code directory.
  assertEquals(await malformed((v) => v.setUint32(3 * 4096 + 100 + 12, 2)), null);
});

/** Run `cmd` and return its exit code and output, or `null` when it is not installed. */
async function run(cmd: string, args: string[]) {
  try {
    const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
    return { code: out.code, text: new TextDecoder().decode(out.stderr) };
  } catch {
    return null;
  }
}

Deno.test({
  name: "repairAdhocSignature: a linker-signed executable with a stale page hash is valid to " +
    "codesign again, and runs",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-macho-" });
    try {
      await Deno.writeTextFile(join(dir, "main.c"), "int main(void) { return 7; }\n");
      const exe = join(dir, "main");
      const cc = await run("cc", ["-o", exe, join(dir, "main.c")]);
      if (!cc || cc.code !== 0) {
        console.warn("  skipped: no C compiler (Xcode Command Line Tools)");
        return;
      }
      const bytes = await Deno.readFile(exe);
      // Make the last code page's hash stale, as Bun's signer leaves it.
      const view = new DataView(bytes.buffer);
      const { cdOffset } = findCodeDirectory(view);
      const hashOffset = view.getUint32(cdOffset + 16);
      const nCode = view.getUint32(cdOffset + 28);
      const hashSize = view.getUint8(cdOffset + 36);
      bytes[cdOffset + hashOffset + (nCode - 1) * hashSize] ^= 0xff;
      await Deno.writeFile(exe, bytes);
      const stale = await run("codesign", ["--verify", exe]);
      assert(stale && stale.code !== 0, "codesign accepted the stale signature");

      const repaired = await repairAdhocSignature(bytes);
      assert(repaired);
      await Deno.writeFile(exe, repaired);
      const verified = await run("codesign", ["--verify", "--verbose", exe]);
      assertEquals(verified?.code, 0, verified?.text);
      assertEquals((await new Deno.Command(exe).output()).code, 7);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** The primary code directory of a thin Mach-O (the test's own parse, independent of src). */
function findCodeDirectory(view: DataView): { cdOffset: number } {
  const ncmds = view.getUint32(16, true);
  let at = 32;
  for (let i = 0; i < ncmds; i++) {
    if (view.getUint32(at, true) === 0x1d) {
      const sig = view.getUint32(at + 8, true);
      return { cdOffset: sig + view.getUint32(sig + 16) };
    }
    at += view.getUint32(at + 4, true);
  }
  throw new Error("no LC_CODE_SIGNATURE");
}
