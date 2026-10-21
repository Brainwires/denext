// The `generic-host` deploy preset: a VPS or bare-metal host. It writes a systemd unit that runs
// the production server (the `build --compile` executable when the build made one, else the
// least-privilege `start` command on denext's Deno toolchain) with the sandboxing systemd offers,
// a `build.sh` that builds a release on the host (dependencies and the toolchain into a `DENO_DIR`
// inside the app directory, so the sandboxed unit resolves nothing at start), an nginx and a Caddy
// reverse-proxy snippet (TLS, the connection ceiling, long cache on content-hashed files), and an
// `env.example` listing the variables the app reads — under `.denext/deploy/generic-host/`, for
// you to copy onto the host. There is no `denext deploy` step: how files reach a host is yours.

import { basename } from "@std/path";
import type { DeployAdapter, DeployContext } from "../adapter.ts";
import type { DeployManifest } from "../manifest.ts";
import { appName, header } from "./shared.ts";
import { splitNetFlag, toolchainNetSplit } from "../../build/net-permissions.ts";

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
  /**
   * The public domain the proxy serves. Default: `denext deploy prepare --domain <host>`, else the
   * host of `DENEXT_CANONICAL_ORIGIN` in the environment `prepare` runs in. With none, nothing
   * names a domain: the unit reads `DENEXT_CANONICAL_ORIGIN` from its env file, nginx answers any
   * host name, Caddy serves plain HTTP on `:80`, and `prepare` warns.
   */
  domain?: string;
  /**
   * The Deno the unit runs the server on (default `<directory>/.deno/bin/deno`: denext's Deno
   * toolchain, which `build.sh` links there); unused with a compiled build.
   */
  deno?: string;
  /** Concurrent connections per client address the proxy allows (default 100). */
  maxConnections?: number;
}

/** The options with every default filled in (`domain` stays `null` when nothing names one). */
type Resolved = Required<Omit<GenericHostPresetOptions, "domain">> & { domain: string | null };

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
  ["domain", (v) => v === null || (typeof v === "string" && SAFE_DOMAIN.test(v)), "a host name"],
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

/** The host of `DENEXT_CANONICAL_ORIGIN` in `prepare`'s environment, or `null`. */
function domainFromEnv(env: (name: string) => string | undefined): string | null {
  const origin = env("DENEXT_CANONICAL_ORIGIN");
  if (!origin) return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

/** Fill in the defaults, then check every value. */
function resolveOptions(options: GenericHostPresetOptions, ctx: DeployContext): Resolved {
  const name = appName(options.name, ctx.projectDir);
  const directory = options.directory ?? `/srv/${name}`;
  return checkOptions({
    name,
    directory,
    user: options.user ?? name,
    port: options.port ?? 3000,
    domain: options.domain ?? domainFromEnv(ctx.env),
    deno: options.deno ?? `${directory}/${TOOLCHAIN_LINK}`,
    maxConnections: options.maxConnections ?? 100,
  });
}

/** `DENO_DIR` on the host, relative to the app directory: the build's caches, read at start. */
const DENO_DIR = ".deno";
/** Where `build.sh` links denext's Deno toolchain, relative to the app directory. */
const TOOLCHAIN_LINK = `${DENO_DIR}/bin/deno`;

/** The denext CLI module the start command runs (the version the build used). */
function cliModule(manifest: DeployManifest): string {
  return manifest.server.command.find((w) =>
    /^(?:jsr:|npm:|https?:\/\/)\S*denext\S*\/cli(?:\.ts)?$/.test(w)
  ) ??
    `jsr:@denext/denext@^${manifest.denext}/cli`;
}

/**
 * The `ExecStart` command line. The server listens on loopback only: the unit trusts the proxy's
 * forwarded headers (`DENEXT_TRUST_PROXY=1`), which is safe only while no client reaches the
 * server without passing the proxy.
 */
function execStart(manifest: DeployManifest, o: Resolved): string {
  const loopback = ["--host", "127.0.0.1"];
  if (manifest.compile) {
    return [`${o.directory}/${basename(manifest.compile.output)}`, ...loopback].join(" ");
  }
  const [first, ...words] = manifest.server.command;
  const binds = words.some((w) => /^--(host|hostname)(=|$)/.test(w));
  const rest = first === "deno" && o.deno === `${o.directory}/${TOOLCHAIN_LINK}`
    ? toolchainNet(words, manifest, binds ? null : o.port)
    : words;
  return [first === "deno" ? o.deno : first, ...rest, ...(binds ? [] : loopback)].join(" ");
}

/**
 * The start command's words on denext's Deno toolchain (`build.sh` links it): where it splits the
 * network grant by direction, the unscoped `--allow-net` becomes `--allow-net-connect` (the app's
 * `compile.permissions.netConnect`, else unscoped) and `--allow-net-listen` (its `netListen`, else
 * the unit's loopback port), so nothing else in the server can open a listener. A command that
 * binds a host of its own (`port` null) keeps listen unscoped unless `netListen` names one.
 */
function toolchainNet(
  words: readonly string[],
  manifest: DeployManifest,
  port: number | null,
): readonly string[] {
  const net = manifest.permissions.net;
  if (!net || !toolchainNetSplit()) return words;
  const scoped = (values: readonly string[]) => values.includes("*") ? undefined : values;
  const listen = scoped(net.listen) ?? (port === null ? undefined : [`127.0.0.1:${port}`]);
  return splitNetFlag(words, listen, scoped(net.connect));
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
# Deploy: put the new release in ${o.directory}, run build.sh there as ${o.user} (unless it is a
# compiled build), then \`systemctl restart ${o.name}\` (SIGTERM drains in-flight requests).
# build.sh resolves every dependency and denext's Deno toolchain into DENO_DIR below, so the
# sandboxed server (ProtectHome, a read-only system) loads them without the network or a home.
[Unit]
Description=${o.name} (denext)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${o.user}
WorkingDirectory=${o.directory}
Environment=PORT=${o.port}
Environment=DENO_DIR=${o.directory}/${DENO_DIR}
${
    o.domain
      ? `Environment=DENEXT_CANONICAL_ORIGIN=https://${o.domain}`
      : "# DENEXT_CANONICAL_ORIGIN (the public https:// origin) comes from the env file below."
  }
Environment=DENEXT_LOG=json
# Behind nginx / Caddy every request comes from 127.0.0.1: trust the proxy's X-Forwarded-*
# headers so clientIp() and the per-address limits (rateLimit(), auth's per-IP budgets, Live's
# per-IP cap) see each client. Safe because the server listens on 127.0.0.1 only (ExecStart).
Environment=DENEXT_TRUST_PROXY=1
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
 * `build.sh`: build a release on the host as the service user — the dependencies, the build and
 * denext's Deno toolchain (downloaded and SHA-256-verified by the CLI) all into the app's own
 * `DENO_DIR`, then the toolchain linked where the unit runs it.
 *
 * @param manifest The deploy manifest.
 * @param o The resolved options.
 * @returns The script.
 */
function renderBuildScript(manifest: DeployManifest, o: Resolved): string {
  return `#!/bin/sh
${header("generic-host", "#")}
#
# Build a release in ${o.directory} as the service user, then restart the unit:
#   sudo -u ${o.user} sh build.sh && sudo systemctl restart ${o.name}
# Needs a \`deno\` on PATH (any version: the build runs on denext's Deno toolchain).
set -eu
cd ${o.directory}
export DENO_DIR=${o.directory}/${DENO_DIR}
deno install
deno task build
# The server runs on the toolchain the build used (Deno.SQL / postgresClient() included).
mkdir -p "$DENO_DIR/bin"
ln -sf "$(deno run -A '${cliModule(manifest)}' toolchain path)" "${o.directory}/${TOOLCHAIN_LINK}"
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
  ${
    o.domain
      ? `server_name ${o.domain};`
      : "# No domain was given: answer any host name.\n  server_name _;"
  }

  # The concurrency ceiling denext expects in front of it (https://denext.dev/docs/deploy).
  limit_conn ${zone}_conn ${o.maxConnections};
  client_max_body_size 10m;

  # Content-hashed files under ${manifest.basePath}/_denext/client/ already carry an immutable
  # Cache-Control from denext, so a CDN in front of this caches them for a year.
  location / {
    proxy_pass http://${zone};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # Overwrite, never append: the server trusts this header (DENEXT_TRUST_PROXY=1 in the
    # unit), so a client's own X-Forwarded-For must not reach it.
    proxy_set_header X-Forwarded-For $remote_addr;
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
${o.domain ?? "# No domain was given: plain HTTP. Put your domain here for automatic TLS.\n:80"} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${o.port}
}
`;
}

/** A variable the app reads, as `env.example` lists it (a secret says how long it must be). */
function envLine(v: DeployManifest["env"][number]): string {
  const secret = /SECRET/.test(v.name)
    ? "\n# at least 32 random characters: `openssl rand -base64 32`"
    : "";
  return `# ${v.required ? "required" : "optional"}${v.public ? ", public" : ""} — ${
    v.sources.join(", ")
  }${secret}\n${v.name}=`;
}

/** The server's own variables, the ones the unit does not set itself. */
function frameworkEnv(manifest: DeployManifest, o: Resolved): string {
  const origin = o.domain
    ? `# DENEXT_CANONICAL_ORIGIN=https://${o.domain}  (set in the unit)`
    : "# required — the public origin (https://your-domain): Server Actions, auth callbacks and\n" +
      "# redirects are checked against it\nDENEXT_CANONICAL_ORIGIN=";
  return `# The server's own settings.
${origin}
# optional — how long SIGTERM waits for in-flight requests (ms); keep it under TimeoutStopSec
# ${manifest.server.drain.env}=${manifest.server.drain.ms}`;
}

/**
 * `env.example`: the server's own settings, then every variable the app reads, required ones
 * first, values left empty.
 *
 * @param manifest The deploy manifest.
 * @param o The resolved options.
 * @returns The file.
 */
function renderEnvExample(manifest: DeployManifest, o: Resolved): string {
  const vars = [...manifest.env].sort((a, b) => Number(b.required) - Number(a.required));
  const app = vars.length
    ? `\n\n# The variables the app reads (from the deploy manifest).\n${
      vars.map(envLine).join("\n")
    }`
    : "";
  return `${header("generic-host", "#")}
#
# Copy to /etc/${o.name}/env (mode 600) and fill in.
${frameworkEnv(manifest, o)}${app}
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
      const o = resolveOptions(options, ctx);
      if (!o.domain) {
        ctx.warn(
          "generic-host: no domain given (genericHost({ domain }), or `denext deploy prepare " +
            "--preset generic-host --domain <host>`): set DENEXT_CANONICAL_ORIGIN in the env file, " +
            "and the domain in nginx.conf's server_name or the Caddyfile's site address",
        );
      }
      await ctx.writeFile(`${o.name}.service`, renderSystemdUnit(ctx.manifest, o));
      if (!ctx.manifest.compile) {
        await ctx.writeFile("build.sh", renderBuildScript(ctx.manifest, o));
      }
      await ctx.writeFile("nginx.conf", renderNginx(ctx.manifest, o));
      await ctx.writeFile("Caddyfile", renderCaddyfile(o));
      await ctx.writeFile("env.example", renderEnvExample(ctx.manifest, o));
      if (ctx.manifest.schedules.length) {
        ctx.warn(
          "generic-host: the schedules run in the server process — run ONE instance, or move " +
            "them to systemd timers running `denext job <name>`",
        );
      }
    },
  };
}
