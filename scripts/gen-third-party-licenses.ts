/**
 * Regenerates `packages/photon/THIRD-PARTY-LICENSES.md` from the crate graph
 * `cargo metadata` resolves for `packages/photon` — i.e. every Rust crate statically
 * linked into `lib/denext_photon.wasm`. Run it after every codec rebuild:
 *
 *     deno task licenses:photon
 *
 * Needs `cargo` and a populated local registry (`--offline`; the `wasmbuild` step
 * populates it). For each crate it records the manifest's SPDX expression, the
 * license we elect where the crate offers a choice (MIT, else Apache-2.0, else the
 * only option; `AND` terms are all kept), the copyright lines from the crate's own
 * license files, and the full text of every elected license that is not the MIT or
 * Apache-2.0 boilerplate (those two are included once).
 *
 * @module
 */
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const CRATE_DIR = join(ROOT, "packages/photon");
const OUT = join(CRATE_DIR, "THIRD-PARTY-LICENSES.md");
/** Our own wrapper crate — it is the licensee, not a third party. */
const ROOT_CRATE = "denext-photon";

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  repository: string | null;
  manifest_path: string;
}

interface CargoMetadata {
  packages: CargoPackage[];
  resolve: { nodes: { id: string }[] };
}

interface Crate {
  name: string;
  version: string;
  spdx: string;
  elected: string[];
  repository: string;
  dir: string;
  files: string[];
  copyrights: string[];
}

interface LicenseText {
  id: string;
  crate: string;
  text: string;
  /** Set when the crate's license file is really the MIT/Apache boilerplate. */
  boilerplate?: "MIT" | "Apache-2.0";
}

async function cargoMetadata(): Promise<CargoMetadata> {
  const out = await new Deno.Command("cargo", {
    args: ["metadata", "--format-version", "1", "--offline"],
    cwd: CRATE_DIR,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!out.success) throw new Error(`cargo metadata failed (exit ${out.code})`);
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

/** The crates that actually end up in the wasm: the resolve graph minus our wrapper. */
function linkedPackages(meta: CargoMetadata): CargoPackage[] {
  const linked = new Set(meta.resolve.nodes.map((n) => n.id));
  return meta.packages
    .filter((p) => linked.has(p.id) && p.name !== ROOT_CRATE)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)/i;

function licenseFiles(dir: string): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isFile && LICENSE_FILE.test(entry.name)) names.push(entry.name);
  }
  return names.sort();
}

/** A real notice: starts with "Copyright" and names a year or a (c)/© mark. */
const NOTICE_LINE = /^copyright\b.*(\d{4}|\(c\)|©)/i;
/** Placeholder lines from license templates ("Copyright [yyyy] [name of copyright owner]"). */
const TEMPLATE_LINE = /\[yyyy\]|\{yyyy\}|<year>|\[name of copyright owner\]/i;

function isNotice(line: string): boolean {
  return NOTICE_LINE.test(line) && !TEMPLATE_LINE.test(line);
}

function noticeLinesOf(path: string): string[] {
  return Deno.readTextFileSync(path).split("\n").map((l) => l.trim()).filter(isNotice);
}

function copyrightLines(dir: string, files: string[]): string[] {
  return [...new Set(files.flatMap((file) => noticeLinesOf(join(dir, file))))];
}

/** Our order of preference when a crate offers a choice. */
const PREFERRED = ["MIT", "Apache-2.0"];

/** Pick one license from an `OR` group: MIT, else Apache-2.0, else the first option. */
function electOne(term: string): string {
  const options = term.replace(/[()]/g, "").split(/\s+OR\s+|\//).map((s) => s.trim());
  return PREFERRED.find((p) => options.includes(p)) ?? options[0];
}

/** One elected license per `OR` group; every `AND` term is kept. */
function electLicenses(spdx: string): string[] {
  return [...new Set(spdx.split(/\s+AND\s+/).map(electOne))];
}

function toCrate(pkg: CargoPackage): Crate {
  const dir = dirname(pkg.manifest_path);
  const files = licenseFiles(dir);
  const spdx = pkg.license ?? "UNKNOWN";
  return {
    name: pkg.name,
    version: pkg.version,
    spdx,
    elected: electLicenses(spdx),
    repository: pkg.repository ?? "—",
    dir,
    files,
    copyrights: copyrightLines(dir, files),
  };
}

function boilerplateOf(text: string): LicenseText["boilerplate"] {
  if (/Apache License/.test(text) && /Version 2\.0/.test(text)) return "Apache-2.0";
  if (/of\s+this\s+software\s+and\s+associated\s+documentation\s+files/.test(text)) return "MIT";
  return undefined;
}

/** The file holding the text of `id` in the crate: `LICENSE-<KEY>` if present, else the bare `LICENSE`. */
function licenseFileFor(crate: Crate, id: string): string | undefined {
  const key = id.split("-")[0].toUpperCase();
  return crate.files.find((f) => f.toUpperCase().includes(key)) ??
    crate.files.find((f) => /^LICEN[CS]E(\.md|\.txt)?$/i.test(f));
}

function licenseTextOf(crate: Crate, id: string): LicenseText {
  const file = licenseFileFor(crate, id);
  const text = file ? Deno.readTextFileSync(join(crate.dir, file)).trim() : "";
  return { id, crate: `${crate.name} ${crate.version}`, text, boilerplate: boilerplateOf(text) };
}

/** The crate's elected licenses that are neither MIT nor Apache-2.0 (those are included once). */
function extraTextsOf(crate: Crate): LicenseText[] {
  return crate.elected.filter((id) => !PREFERRED.includes(id)).map((id) =>
    licenseTextOf(crate, id)
  );
}

function extraTexts(crates: Crate[]): LicenseText[] {
  return crates.flatMap(extraTextsOf);
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function renderHeader(crates: Crate[]): string {
  const photon = crates.find((c) => c.name === "photon-rs");
  return `# Third-party licenses — \`@denext/photon\`

<!-- GENERATED by scripts/gen-third-party-licenses.ts (deno task licenses:photon). Do not edit. -->

The \`@denext/photon\` wrapper (\`mod.ts\`, \`src/lib.rs\`) is Apache-2.0 (see \`LICENSE\`).
\`lib/denext_photon.wasm\` is a static build of
[photon-rs](https://github.com/silvia-odwyer/photon) ${photon?.version ?? ""} and the
${crates.length - 1} transitive Rust crates it pulls in, all listed below; \`lib/*.js\` and
\`lib/*.d.ts\` are glue generated by \`wasm-bindgen\` (listed too). Every crate is under a
permissive license. Where a crate offers a choice we elect **MIT**, else **Apache-2.0**,
else its only option; \`AND\` terms are all retained. The **Elected** column records that
choice, **Copyright notices** reproduces each crate's own notice lines, and **License
texts** carries the full text of every elected license that is not the MIT or Apache-2.0
boilerplate (each of those is included once).

## Bundled crates
`;
}

function renderTable(crates: Crate[]): string {
  const rows = crates.map((c) =>
    `| ${c.name} | ${c.version} | ${c.spdx} | ${c.elected.join(" + ")} | ${c.repository} |`
  );
  return [
    "| Crate | Version | License (manifest) | Elected | Source |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function renderNotices(crates: Crate[]): string {
  const items = crates.map((c) => {
    const lines = c.copyrights.length
      ? c.copyrights.join("; ")
      : `© the ${c.name} authors (the crate's license files carry no copyright line)`;
    return `- **${c.name} ${c.version}** — ${lines}`;
  });
  return `## Copyright notices\n\n${items.join("\n")}\n`;
}

function renderExtraText(t: LicenseText): string {
  if (t.boilerplate) {
    return `### ${t.id} — ${t.crate}\n\nThe crate's manifest declares \`${t.id}\`, but the license file it ships is the ` +
      `${t.boilerplate} text (see above); no separate text to reproduce.\n`;
  }
  return `### ${t.id} — ${t.crate}\n\n\`\`\`\n${t.text}\n\`\`\`\n`;
}

function renderTexts(crates: Crate[]): string {
  const extra = extraTexts(crates).map(renderExtraText);
  return [
    "## License texts",
    "",
    "### Apache-2.0",
    "",
    "The full Apache License 2.0 text is this package's `LICENSE` file; it applies to every",
    "crate whose elected license is Apache-2.0.",
    "",
    "### MIT",
    "",
    "Applies to every crate whose elected license is MIT, with the copyright holders listed",
    "under **Copyright notices**.",
    "",
    "```",
    MIT_TEXT,
    "```",
    "",
    ...extra,
  ].join("\n");
}

async function main(): Promise<void> {
  const crates = linkedPackages(await cargoMetadata()).map(toCrate);
  const doc = renderHeader(crates) + "\n" + renderTable(crates) + "\n" + renderNotices(crates) +
    "\n" + renderTexts(crates);
  await Deno.writeTextFile(OUT, doc);
  console.log(`wrote ${OUT} (${crates.length} crates)`);
}

if (import.meta.main) await main();
