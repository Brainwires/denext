// Linux: a systemd timer + oneshot service per job. `OnCalendar=` takes a time zone, so the
// schedule is written in UTC exactly as denext evaluates it — no translation, no guard. A user
// entry goes to ~/.config/systemd/user (`systemctl --user`); a system one to /etc/systemd/system,
// running as the installing user (`User=`).

// POSIX paths whatever machine renders the entry: the scheduler is a POSIX one.
import { join } from "@std/path/posix";
import type { SchedulerHost } from "./host.ts";
import {
  type Backend,
  type BackendContext,
  check,
  type EntrySpec,
  markedSlug,
  marker,
  pad2,
} from "./spec.ts";
import { type CalendarRule, type DaySelector, timeGroups } from "./translate.ts";

/** systemd's weekday names, indexed by the POSIX number (0 = Sunday). */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A comma list of two-digit values, or `*` for the whole domain. */
function list(values: readonly number[] | undefined, domain: number): string {
  return !values || values.length === domain ? "*" : values.map(pad2).join(",");
}

/** The date-and-weekday halves one selector needs (two for Vixie's either-day rule). */
function dateParts(days: DaySelector): string[] {
  const month = list(days.month, 12);
  const weekday = (dow: readonly number[]) => `${dow.map((d) => DAY_NAMES[d]).join(",")} `;
  if (days.either) {
    return [`*-${month}-${list(days.dom, 31)}`, `${weekday(days.dow ?? [])}*-${month}-*`];
  }
  const dow = days.dow ? weekday(days.dow) : "";
  return [`${dow}*-${month}-${list(days.dom, 31)}`];
}

/**
 * The `OnCalendar=` values for some rules (UTC rules: this backend is never shifted).
 *
 * @param rules The job's rules.
 * @returns One value per (date part × time group), each ending ` UTC`.
 */
export function onCalendarValues(rules: readonly CalendarRule[]): string[] {
  return rules.flatMap((rule) =>
    dateParts(rule.days).flatMap((date) =>
      timeGroups(rule.times).map((g) =>
        `${date} ${list(g.hours, 24)}:${list(g.minutes, 60)}:00 UTC`
      )
    )
  );
}

/** One argument as systemd's `ExecStart=` reads it (quoted, specifiers and variables escaped). */
function execArg(arg: string): string {
  const escaped = arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")
    .replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

/** The unit name stem of a job's entry. */
function systemdUnitName(projectId: string, slug: string): string {
  return `denext-job-${projectId}-${slug}`;
}

/**
 * A job's service and timer units.
 *
 * @param entry The job's entry.
 * @param ctx The project and scope.
 */
function renderSystemdUnits(
  entry: EntrySpec,
  ctx: BackendContext,
): { service: string; timer: string } {
  const head = [
    `# ${marker(ctx.project.id, entry.slug)}`,
    `# Written by \`denext job install\` for ${ctx.project.dir}; ` +
    `\`denext job install --uninstall\` removes it.`,
  ];
  const description = `Description=denext job ${entry.job} (${ctx.project.dir})`
    .replace(/%/g, "%%");
  const service = [
    ...head,
    `[Unit]`,
    description,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `WorkingDirectory=${ctx.project.dir.replace(/%/g, "%%")}`,
    ...(ctx.scope === "system" && ctx.runAs ? [`User=${ctx.runAs}`] : []),
    `ExecStart=${entry.argv.map(execArg).join(" ")}`,
    ``,
  ].join("\n");
  const timer = [
    ...head,
    `[Unit]`,
    description,
    ``,
    `[Timer]`,
    ...onCalendarValues(entry.schedule.rules).map((v) => `OnCalendar=${v}`),
    // Fire on the minute (the default lets systemd batch timers up to a minute late), and never
    // catch up a missed run at boot: denext's schedules don't fire on startup.
    `AccuracySec=1s`,
    `Persistent=false`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");
  return { service, timer };
}

/** Where the units live, and the `systemctl` scope flag. */
function place(host: SchedulerHost, ctx: BackendContext): { dir: string; scope: string[] } {
  if (ctx.scope === "system") return { dir: "/etc/systemd/system", scope: [] };
  const config = host.env("XDG_CONFIG_HOME") || join(host.home, ".config");
  return { dir: join(config, "systemd", "user"), scope: ["--user"] };
}

/** This project's timer files, by slug. */
async function ours(host: SchedulerHost, ctx: BackendContext): Promise<Map<string, string>> {
  const { dir } = place(host, ctx);
  const prefix = systemdUnitName(ctx.project.id, "");
  const found = new Map<string, string>();
  for (const name of await host.readDir(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".timer")) continue;
    const slug = markedSlug((await host.readTextFile(join(dir, name))) ?? "", ctx.project.id);
    if (slug) found.set(slug, name.slice(0, -".timer".length));
  }
  return found;
}

/** Runs `systemctl [--user] <args>`. */
function systemctl(host: SchedulerHost, scope: string[], args: string[], mutates = true) {
  return host.run("systemctl", [...scope, ...args], { mutates });
}

/** The systemd backend. */
export const systemdBackend: Backend = {
  name: "systemd",
  clock: "utc",
  validate: () => {},
  available: async (host, ctx) => {
    if (host.os !== "linux") return false;
    const { scope } = place(host, ctx);
    return (await systemctl(host, scope, ["show-environment"], false)).code === 0;
  },
  list: async (host, ctx) => [...(await ours(host, ctx)).keys()].sort(),
  install: async (host, ctx, entries) => {
    const { dir, scope } = place(host, ctx);
    const units: string[] = [];
    for (const entry of entries) {
      const unit = systemdUnitName(ctx.project.id, entry.slug);
      const { service, timer } = renderSystemdUnits(entry, ctx);
      await host.writeFile(join(dir, `${unit}.service`), service);
      await host.writeFile(join(dir, `${unit}.timer`), timer);
      units.push(`${unit}.timer`);
    }
    if (units.length === 0) return;
    check(await systemctl(host, scope, ["daemon-reload"]), "systemctl daemon-reload");
    check(await systemctl(host, scope, ["enable", ...units]), "systemctl enable");
    // `restart`, not `start`: a timer that was already running picks up its new calendar.
    check(await systemctl(host, scope, ["restart", ...units]), "systemctl restart");
  },
  remove: async (host, ctx, slugs) => {
    const { dir, scope } = place(host, ctx);
    const existing = await ours(host, ctx);
    const units = slugs.flatMap((slug) => existing.has(slug) ? [existing.get(slug) as string] : []);
    if (units.length === 0) return;
    await systemctl(host, scope, ["disable", "--now", ...units.map((u) => `${u}.timer`)]);
    for (const unit of units) {
      await host.remove(join(dir, `${unit}.timer`));
      await host.remove(join(dir, `${unit}.service`));
    }
    check(await systemctl(host, scope, ["daemon-reload"]), "systemctl daemon-reload");
  },
};
