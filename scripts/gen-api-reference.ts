// Generate the in-site API reference from `deno doc --json` (2.0 Pillar VII).
// Runs deno doc over denext's public entry points and emits a compact JSON the docs
// site renders at /docs/api. Run: `deno run -A scripts/gen-api-reference.ts`.

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = `${ROOT}examples/docs/app/docs/api/reference.json`;

/** Public entry points, in the order they appear in the reference. */
const ENTRIES: { module: string; file: string }[] = [
  { module: "denext", file: `${ROOT}mod.ts` },
  { module: "denext/server", file: `${ROOT}src/server/mod.ts` },
  { module: "denext/client", file: `${ROOT}src/client/mod.ts` },
];

interface Symbol {
  name: string;
  kind: string;
  signature: string;
  doc: string;
}
interface Group {
  module: string;
  symbols: Symbol[];
}

// deno doc represents a type as `{ repr, kind, ... }`; `repr` is empty for some
// composite types, so fall back to the kind.
// deno-lint-ignore no-explicit-any
const typeStr = (t: any): string => (t?.repr && t.repr.length ? t.repr : (t?.kind ?? "unknown"));

// deno-lint-ignore no-explicit-any
function signatureOf(name: string, decl: any): string {
  const def = decl.def ?? {};
  const tp = (def.typeParams ?? []).map((p: { name: string }) => p.name);
  const tpStr = tp.length ? `<${tp.join(", ")}>` : "";
  switch (decl.kind) {
    case "function": {
      // deno-lint-ignore no-explicit-any
      const params = (def.params ?? []).map((p: any) =>
        `${p.name ?? "_"}${p.optional ? "?" : ""}: ${typeStr(p.tsType)}`
      ).join(", ");
      return `${name}${tpStr}(${params}): ${typeStr(def.returnType)}`;
    }
    case "variable":
      return `${name}: ${typeStr(def.tsType)}`;
    case "typeAlias":
      return `type ${name}${tpStr} = ${typeStr(def.tsType)}`;
    case "interface":
      return `interface ${name}${tpStr}`;
    case "class":
      return `class ${name}${tpStr}`;
    case "enum":
      return `enum ${name}`;
    default:
      return name;
  }
}

// deno-lint-ignore no-explicit-any
function docSummary(decl: any): string {
  const doc: string = decl.jsDoc?.doc ?? "";
  // First paragraph only, whitespace-collapsed.
  return doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
}

async function docFor(file: string): Promise<Group["symbols"]> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(`deno doc failed for ${file}: ${new TextDecoder().decode(stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout));
  // v2: { nodes: { "<file url>": { symbols: [...] } } }
  // deno-lint-ignore no-explicit-any
  const symbols: any[] = Object.values(parsed.nodes ?? {}).flatMap((n: any) => n.symbols ?? []);
  const seen = new Set<string>();
  const out: Symbol[] = [];
  for (const s of symbols) {
    if (seen.has(s.name)) continue;
    const decl = s.declarations?.[0];
    if (!decl || decl.declarationKind === "private") continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      kind: decl.kind,
      signature: signatureOf(s.name, decl),
      doc: docSummary(decl),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const groups: Group[] = [];
for (const { module, file } of ENTRIES) {
  groups.push({ module, symbols: await docFor(file) });
}

await Deno.mkdir(new URL(".", `file://${OUT}`).pathname, { recursive: true });
await Deno.writeTextFile(OUT, JSON.stringify({ groups }, null, 2) + "\n");
const total = groups.reduce((n, g) => n + g.symbols.length, 0);
console.log(`api reference: ${total} symbols across ${groups.length} entries → ${OUT}`);
