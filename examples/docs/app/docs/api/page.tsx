import { Code, DocsShell } from "../../../components/ui.tsx";
import reference from "./reference.json" with { type: "json" };

export const metadata = {
  title: "API reference",
  description:
    "Every public export of denext, denext/server, and denext/client — auto-generated from the source with deno doc.",
};

const total = reference.groups.reduce((n, g) => n + g.symbols.length, 0);
const anchor = (mod: string, name: string) => `${mod.replace(/\//g, "-")}-${name}`;

export default function ApiReference() {
  return (
    <DocsShell
      active="api"
      title="API reference"
      lead="Every public export of denext, denext/server, and denext/client — generated straight from the source with deno doc, so it never drifts from the code."
    >
      <p>
        {total} symbols across three entry points. Use your browser's find (⌘/Ctrl-F) to jump
        to a name. Regenerate with <code>deno run -A scripts/gen-api-reference.ts</code>.
      </p>
      {reference.groups.map((g) => (
        <section key={g.module}>
          <h2>
            <code>{g.module}</code>
          </h2>
          {g.symbols.map((s) => (
            <div key={s.name} class="api-symbol">
              <h3 id={anchor(g.module, s.name)}>
                <code>{s.name}</code> <span class="api-kind">{s.kind}</span>
              </h3>
              <Code lang="ts">{s.signature}</Code>
              {s.doc ? <p>{s.doc}</p> : null}
            </div>
          ))}
        </section>
      ))}
    </DocsShell>
  );
}
