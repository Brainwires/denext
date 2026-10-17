// The `generic-host` deploy preset: a VPS or bare-metal host. It writes a systemd unit that runs
// the production server (the `build --compile` executable when the build made one, else the
// least-privilege `start` command) with the sandboxing systemd offers, an nginx and a Caddy
// reverse-proxy snippet (TLS, the connection ceiling, long cache on content-hashed files), and an
// `env.example` listing the variables the app reads — under `.denext/deploy/generic-host/`, for
// you to copy onto the host. There is no `denext deploy` step: how files reach a host is yours.

import { basename } from "@std/path";
import type { DeployAdapter } from "../adapter.ts";
import type { DeployManifest } from "../manifest.ts";
import { appName, header } from "./shared.ts";

/** Options for {@linkcode genericHost}. */
export interface GenericHostPresetOptions {
  /** The service's name (default: the project directory's name). */
  name?: string;
  /** Where the app lives on the host (default `/srv/<name>`). */
  directory?: string;
  /** The user the service runs as (default: the service's name). */
  user?: string;
  /** The port the server listens on behind the proxy (default 3000). */
  port?: number;
  /** The public domain the proxy serves (default `example.com`). */
  domain?: string;
  /** The `deno` the unit runs (default `/usr/local/bin/deno`); unused with a compiled build. */
  deno?: string;
  /** Concurrent connections per client address the proxy allows (default 100). */
  maxConnections?: number;
}

/** The options with every default filled in. */
type Resolved = Required<GenericHostPresetOptions>;

/** An absolute path a unit file and a shell take as one word. */
const SAFE_PATH = /^\/[A-Za-z0-9._@+\/-]*$/;
/** A host name (or `*.` wildcard) nginx's `server_name` and a Caddy site address take as is. */
const SAFE_DOMAIN =
  /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
/** A POSIX user name. */
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

const safePath = (v: unknown) =>
  typeof v === "string" && SAFE_PATH.test(v) && !v.split("/").includes("..");
const PATH_RULE = "an absolute path of letters, digits and ._@+-/";

/** Each option's check and what it must be. */
const OPTION_RULES: ReadonlyArray<readonly [keyof Resolved, (v: unknown) => boolean, string]> = [
  ["directory", safePath, PATH_RULE],
  ["deno", safePath, PATH_RULE],
  ["user", (v) => typeof v === "string" && SAFE_USER.test(v), "a user name"],
  ["domain", (v) => typeof v === "string" && SAFE_DOMAIN.test(v), "a host name"],
  [
    "port",
    (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535,
    "a TCP port",
  ],
  ["maxConnections", (v) => Number.isInteger(v) && (v as number) >= 1, "a positive whole number"],
];

/**
 * The options as they go into the generated files: each is checked, so a value can't end its line
 * or its directive (a newline in `domain`, a `;` in `directory`) and add another.
 */
function checkOptions(o: Resolved): Resolved {
  for (const [key, ok, what] of OPTION_RULES) {
    if (!ok(o[key])) {
      throw new Error(
        `denext: deploy (generic-host) option ${key} ${JSON.stringify(o[key])} is not ${what}`,
      );
    }
  }
  return o;
}

/** Fill in the defaults, then check every value. */
function resolveOptions(options: GenericHostPresetOptions, projectDir: string): Resolved {
  const name = appName(options.name, projectDir);
  return checkOptions({
    name,
    directory: options.directory ?? `/srv/${name}`,
    user: options.user ?? name,
    port: options.port ?? 3000,
    domain: options.domain ?? "example.com",
    deno: options.deno ?? "/usr/local/bin/deno",
    maxConnections: options.maxConnections ?? 100,
  });
}

/** The `ExecStart` command line. */
function execStart(manifest: DeployManifest, o: Resolved): string {
  if (manifest.compile) return `${o.directory}/${basename(manifest.compile.output)}`;
  const [first, ...rest] = manifest.server.command;
  return [first === "deno" ? o.deno : first, ...rest].join(" ");
}

/**
 * The systemd unit.
 *
 * @param manifest The deploy manifest.
 * @param o The resolved options.
 * @returns The unit file.
 */
function renderSystemdUnit(manifest: DeployManifest, o: Resolved): string {
  return `${header("generic-host", "#")}
#
# Install: copy to /etc/systemd/system/${o.name}.service, put the variables from env.example in
# /etc/${o.name}/env (mode 600), then \`systemctl daemon-reload && systemctl enable --now ${o.name}\`.
# Deploy: put the new release in ${o.directory}, run \`deno task build\` there (unless it is a
# compiled build), then \`systemctl restart ${o.name}\` (SIGTERM drains in-flight requests).
[Unit]
Description=${o.name} (denext)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${o.user}
WorkingDirectory=${o.directory}
Environment=PORT=${o.port}
Environment=DENEXT_CANONICAL_ORIGIN=https://${o.domain}
Environment=DENEXT_LOG=json
EnvironmentFile=-/etc/${o.name}/env
ExecStart=${execStart(manifest, o)}
Restart=always
RestartSec=2
KillSignal=SIGTERM
# Above the ${manifest.server.drain.ms / 1000} s drain (${manifest.server.drain.env}).
TimeoutStopSec=30
# Sandboxing: the server writes only its build directory (the durable cache, job history).
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${o.directory}/${manifest.server.buildDir}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * The nginx server block.
 *
 * @param manifest The deploy manifest.
 * @param o The resolved options.
 * @returns The snippet.
 */
function renderNginx(manifest: DeployManifest, o: Resolved): string {
  const zone = o.name.replaceAll("-", "_");
  return `${header("generic-host", "#")}
#
# Include in nginx's http block (e.g. /etc/nginx/conf.d/${o.name}.conf), then add TLS (certbot).
limit_conn_zone $binary_remote_addr zone=${zone}_conn:10m;

# WebSocket upgrades (Live) get "Connection: upgrade"; everything else keeps the upstream alive.
map $http_upgrade $${zone}_connection {
  default upgrade;
  "" "";
}

upstream ${zone} {
  server 127.0.0.1:${o.port};
  keepalive 32;
}

server {
  listen 80;
  server_name ${o.domain};

  # The concurrency ceiling denext expects in front of it (https://denext.dev/docs/deploy).
  limit_conn ${zone}_conn ${o.maxConnections};
  client_max_body_size 10m;

  # Content-hashed files under ${manifest.basePath}/_denext/client/ already carry an immutable
  # Cache-Control from denext, so a CDN in front of this caches them for a year.
  location / {
    proxy_pass http://${zone};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Live (WebSocket) and streamed responses.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $${zone}_connection;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
`;
}

/**
 * The Caddyfile.
 *
 * @param o The resolved options.
 * @returns The snippet.
 */
function renderCaddyfile(o: Resolved): string {
  return `${header("generic-host", "#")}
#
# Caddy terminates TLS for the domain itself; WebSockets and streaming pass through.
${o.domain} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${o.port}
}
`;
}

/**
 * `env.example`: every variable the app reads, required ones first, values left empty.
 *
 * @param manifest The deploy manifest.
 * @returns The file.
 */
function renderEnvExample(manifest: DeployManifest): string {
  const line = (v: DeployManifest["env"][number]) =>
    `# ${v.required ? "required" : "optional"}${v.public ? ", public" : ""} — ${
      v.sources.join(", ")
    }\n${v.name}=`;
  const vars = [...manifest.env].sort((a, b) => Number(b.required) - Number(a.required));
  return `${header("generic-host", "#")}
#
# The variables the app reads (from the deploy manifest). Copy to /etc/<name>/env and fill in.
${vars.map(line).join("\n")}
`;
}

/**
 * The generic-host preset: a systemd unit, nginx and Caddy snippets and an env example.
 *
 * @param options The host options.
 * @returns The adapter.
 */
export function genericHost(options: GenericHostPresetOptions = {}): DeployAdapter {
  return {
    name: "generic-host",
    prepare: async (ctx) => {
      const o = resolveOptions(options, ctx.projectDir);
      await ctx.writeFile(`${o.name}.service`, renderSystemdUnit(ctx.manifest, o));
      await ctx.writeFile("nginx.conf", renderNginx(ctx.manifest, o));
      await ctx.writeFile("Caddyfile", renderCaddyfile(o));
      await ctx.writeFile("env.example", renderEnvExample(ctx.manifest));
      if (ctx.manifest.schedules.length) {
        ctx.warn(
          "generic-host: the schedules run in the server process — run ONE instance, or move " +
            "them to systemd timers running `denext job <name>`",
        );
      }
    },
  };
}
