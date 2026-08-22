import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = { title: "Styling" };

export default function Styling() {
  return (
    <DocsShell
      active="styling"
      title="Styling"
      lead="Global CSS, CSS Modules, and Tailwind — all first-party, all compiled at build time so your pages still ship 0 KB of JavaScript."
    >
      <h2>Global CSS</h2>
      <p>
        Import a stylesheet from your root layout, or link it from the layout's{" "}
        <code>metadata.head</code>. It's served as a static asset.
      </p>
      <Code lang="tsx">
        {`// app/layout.tsx
export const metadata = {
  head: '<link rel="stylesheet" href="/styles.css">',
};`}
      </Code>

      <h2>CSS Modules</h2>
      <p>
        Name a file <code>*.module.css</code>{" "}
        and import it for locally-scoped class names — no collisions, no runtime.
      </p>
      <Code lang="tsx">
        {`// button.module.css
.primary { background: #7aa2ff; color: #071021; }

// Button.tsx
import styles from "./button.module.css";

export function Button(props) {
  return <button class={styles.primary} {...props} />;
}`}
      </Code>
      <Callout kind="note">
        Class names are hashed at build time and the CSS is emitted as a static file — the component
        stays a Server Component and ships no JavaScript.
      </Callout>

      <h2>Tailwind</h2>
      <p>
        Tailwind v4 is supported first-party — denext manages the standalone binary. Point{" "}
        <code>tailwind: {"{ input, output }"}</code>{" "}
        at a directive stylesheet and the compiled file to emit; <code>dev</code>/<code>build</code>
        {" "}
        compile it automatically. Import the <em>output</em> from your layout.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  tailwind: {
    input: "./app/tailwind.css",   // contains: @import "tailwindcss";
    output: "./app/globals.css",   // compiled file, imported by your layout
  },
} satisfies DenextConfig;`}
      </Code>
      <Code lang="tsx">
        {`export default function Card() {
  return <div class="rounded-xl border p-6 shadow">Hello</div>;
}`}
      </Code>

      <Callout kind="note">
        Prefer <code>class</code> over <code>className</code> in denext (both work). See the{" "}
        <code>examples/tailwind</code> app for a complete setup.
      </Callout>
    </DocsShell>
  );
}
