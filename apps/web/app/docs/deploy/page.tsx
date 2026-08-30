import { Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = { title: "Deployment" };

export default function Deploy() {
  return (
    <DocsShell
      active="deploy"
      title="Deployment"
      lead="Build once, run anywhere Deno runs — a container, Deno Deploy, or a static host."
    >
      <h2>Build & start</h2>
      <Code lang="sh">
        {`deno task build   # bundles client entries + CSS into .denext/
deno task start   # serves the production build`}
      </Code>

      <h2>Static export</h2>
      <p>
        If your app is fully static (no per-request data), export it to plain HTML and host it
        anywhere — this very docs site is built that way:
      </p>
      <Code lang="sh">
        {`deno task export   # writes out/ — pure HTML, 0 KB JS on static pages`}
      </Code>

      <h2>Docker</h2>
      <Code lang="dockerfile">
        {`FROM denoland/deno:latest
WORKDIR /app
COPY . .
RUN deno task build
EXPOSE 3000
CMD ["deno", "task", "start"]`}
      </Code>

      <h2>Deno Deploy</h2>
      <p>
        Point Deno Deploy at your repo with the entry command{" "}
        <code>deno task start</code>. denext's cache defaults to Deno's built-in{" "}
        <code>node:sqlite</code>{" "}
        (a local SQLite file), but Deno Deploy has no persistent local filesystem, so the cache
        falls back to a per-instance <strong>in-memory</strong>{" "}
        store there. For a cache that's durable and shared across edge instances, inject your own
        {" "}
        <code>CacheStore</code> via <code>cache.store</code> in <code>denext.config.ts</code>.
      </p>

      <h2>Production notes</h2>
      <ul>
        <li>
          The server drains gracefully, enforces a per-request timeout, and can cap in-process
          concurrency.
        </li>
        <li>
          A <code>/_denext/health</code>{" "}
          endpoint reports liveness and cache reachability for load balancers.
        </li>
        <li>
          Set a strong <code>SESSION_SECRET</code>; cookies are Secure over HTTPS by default.
        </li>
      </ul>
    </DocsShell>
  );
}
