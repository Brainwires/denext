// What earlier releases' native installers wrote, read from the committed fixture
// (tests/fixtures/release-templates.json, made by scripts/gen-release-template-fixtures.ts from
// the release tags). The upgrade tests run from it everywhere, CI's tagless checkout included,
// so none of them is ignored for want of a tag.

import type { ReleaseTemplates } from "../scripts/gen-release-template-fixtures.ts";

export { MAIN_ACTIVITY_PACKAGE } from "../scripts/gen-release-template-fixtures.ts";

const FIXTURE: ReleaseTemplates = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/release-templates.json", import.meta.url)),
);

function blob(key: string): string {
  const text = FIXTURE.blobs[key];
  if (text === undefined) throw new Error(`release-templates.json: no blob ${key}`);
  return text;
}

function at<T>(table: Record<string, T>, tag: string, what: string): T {
  const hit = table[tag];
  if (hit === undefined) {
    throw new Error(
      `release-templates.json has no ${what} for ${tag}: add the tag to ` +
        "scripts/gen-release-template-fixtures.ts and re-run it",
    );
  }
  return hit;
}

const texts = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([name, key]) => [name, blob(key)]));

/** The OTA templates as released at `tag` (`OTA_IOS_FILES` + `OTA_ANDROID_FILES`). */
export function otaTemplatesAt(tag: string): Record<string, string> {
  return texts(at(FIXTURE.otaRaw, tag, "raw OTA templates"));
}

/** The OTA files exactly as `add-ota` wrote them at `tag` (marker line included). */
export function writtenOtaTemplatesAt(
  tag: string,
): { generation: number; files: Record<string, string> } {
  const { generation, files } = at(FIXTURE.otaWritten, tag, "written OTA templates");
  return { generation, files: texts(files) };
}

/** The OTA-only MainActivity `add-ota` wrote at `tag` (v2.7.0 … v2.9.0) for `pkg`. */
export function preparedMainActivityAt(tag: string, pkg: string): string {
  return blob(at(FIXTURE.mainActivityPrepared, tag, "preparedMainActivity")).replace(
    "${pkg}",
    pkg,
  );
}

/** `mainActivitySource` at `tag` for every feature combination, for `MAIN_ACTIVITY_PACKAGE`. */
export function composedMainActivitiesAt<F extends string>(
  tag: string,
): Array<{ set: F[]; text: string }> {
  return at(FIXTURE.mainActivityComposed, tag, "composed MainActivity sources").map((
    { set, text },
  ) => ({ set: set as F[], text: blob(text) }));
}
