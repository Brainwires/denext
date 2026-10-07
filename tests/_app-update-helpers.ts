// Shared by the full-app update tests: a fake runtime library carrying `deno desktop`'s compiled
// app metadata, and a fake macOS bundle "built as" a version (what the publisher and the runtime
// read the version back from).

import { join } from "@std/path";

/**
 * A fake runtime library the way `deno desktop` lays it out: noise, the bare magic (as the
 * section lookup's own code has it), then the data section (magic, u64 LE length, metadata JSON).
 */
export function library(metadata: Record<string, unknown>, noise = 300): Uint8Array {
  const enc = new TextEncoder();
  const json = enc.encode(JSON.stringify(metadata));
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(json.length), true);
  return Uint8Array.from([
    ...Array.from({ length: noise }, (_, i) => i % 251),
    ...enc.encode('find_section("d3n0l4nd")'),
    ...new Array(37).fill(0xff),
    ...enc.encode("d3n0l4nd"),
    ...len,
    ...json,
    ...new Array(64).fill(0),
  ]);
}

/** The standalone metadata of an app built as `version` (`null`: built without one). */
export const metadata = (version: string | null) => ({
  argv: [],
  entrypoint_key: "file:///main.ts",
  ...(version === null ? {} : { app_version: version }),
});

/** Make the fake macOS bundle at `app` one `deno desktop` built as `version`. */
export async function buildAs(
  app: string,
  version: string | null,
  short?: string,
): Promise<string> {
  await Deno.writeTextFile(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>CFBundleExecutable</key>\n` +
      `<string>app</string>\n` +
      (short === undefined && version === null
        ? ""
        : `<key>CFBundleShortVersionString</key>\n<string>${
          short ?? version!.split(/[-+]/)[0]
        }</string>\n`) +
      `</dict></plist>\n`,
  );
  await Deno.writeFile(join(app, "Contents", "MacOS", "app.dylib"), library(metadata(version)));
  return app;
}
