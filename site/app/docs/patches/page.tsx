import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Patching packages — and denext itself",
  description:
    "denext patch records an edit to an npm package or to denext's own sources as a reviewable patch file and re-applies it at every start.",
};

export default function PatchesDocs() {
  return (
    <DocsShell
      active="patches"
      title="Patching packages"
      lead="A dependency has a bug you can't wait on. Edit it in place, record the edit as a patch, and denext re-applies it every time the app starts — the same workflow as patch-package, extended to denext itself."
    >
      <h2>The workflow</h2>
      <p>
        A patch is a unified diff in <code>patches/&lt;name&gt;+&lt;version&gt;.patch</code>{" "}
        — patch-package's file convention, so it is reviewable in a pull request and applies with
        the system <code>patch</code> tool too. Commit the <code>patches/</code> directory; every
        {" "}
        <code>dev</code>, <code>build</code>, <code>start</code> and <code>export</code>{" "}
        applies what it finds there before loading the app.
      </p>
      <Code lang="sh">
        {`# an npm package: edit it where it is installed, then record the edit
denext patch edit left-pad index.js     # prints node_modules/left-pad/index.js
denext patch create left-pad            # → patches/left-pad+1.3.0.patch

denext patch list                       # indexed
denext patch delete 1                   # or: denext patch delete left-pad
denext patch apply                      # what dev/build/start do at boot`}
      </Code>
      <p>
        <code>create</code> diffs the installed files in <code>node_modules/&lt;pkg&gt;</code>{" "}
        against a pristine copy (Deno's npm cache, fetched on demand). <code>apply</code>{" "}
        writes the patched files back into <code>node_modules</code>{" "}
        and is idempotent: a file the patch already transformed is recognized and left alone, so a
        reinstall is healed at the next start. <code>delete</code>{" "}
        reverts the files and removes the patch.
      </p>

      <h2>Patching denext</h2>
      <p>
        The framework arrives from JSR, so there is no file to edit in place.{" "}
        <code>denext patch edit denext &lt;path&gt;</code>{" "}
        copies the pristine source into a working copy under{" "}
        <code>patches/.work/denext/</code>; edit it, then <code>create denext</code>.
      </p>
      <Code lang="sh">
        {`denext patch edit denext src/server/document.ts
#   → edit patches/.work/denext/src/server/document.ts
denext patch create denext
#   → patches/denext+2.0.6.patch
#     materialized into patches/denext/, mapped in deno.json — takes effect on the next start`}
      </Code>
      <p>
        Two things happen on <code>create</code>. The patched file is materialized into{" "}
        <code>patches/denext/&lt;path&gt;</code>{" "}
        with its relative imports rewritten to absolute framework URLs (the copy lives elsewhere
        now), and the app's <code>deno.json</code>{" "}
        import map gains an entry mapping that file's full URL (
        <code>https://jsr.io/@denext/denext/2.0.6/src/server/document.ts</code>) to the copy. Deno
        applies import maps to the resolved URL of every import, the framework's own relative
        imports included, so one file of the published package is overridden without vendoring the
        rest. Compat builds (the React drop-in) prebuild the framework runtime with esbuild and read
        the sources themselves; there the same diff is applied in memory on load.
      </p>
      <Callout kind="note">
        Commit <code>patches/denext/</code> along with the patch file: <code>deno.json</code>{" "}
        references it, and Deno resolves the module graph before anything runs, so a fresh clone
        needs the materialized copy present at startup. <code>patches/.work/</code> is scratch.
      </Callout>

      <h2>Versions</h2>
      <p>
        The version in the file name is what the patch was made against. After an upgrade, apply
        still tries: hunks are located by context within a bounded offset, a mismatch is reported as
        a warning, and a hunk whose context is gone fails the start with its number and file so it
        is never skipped silently. Re-run <code>create</code>{" "}
        against the new version to re-key the patch.
      </p>

      <h2>What it needs</h2>
      <ul>
        <li>
          npm patches need a <code>node_modules</code> directory: <code>nodeModulesDir</code>{" "}
          <code>"auto"</code> or <code>"manual"</code> (what every migrated app has). Under{" "}
          <code>"none"</code>{" "}
          Deno reads packages from its shared global cache, which denext will not modify.
        </li>
        <li>
          The denext patch needs a <code>deno.json</code> (not{" "}
          <code>deno.jsonc</code>) to manage its import-map entries; the managed entries are the
          ones whose value starts with <code>./patches/denext/</code>.
        </li>
      </ul>
    </DocsShell>
  );
}
