// macOS: one launchd property list per job, `StartCalendarInterval` in local time. A user entry
// is an agent in ~/Library/LaunchAgents (the `gui/<uid>` domain); a system one a daemon in
// /Library/LaunchDaemons (the `system` domain) that runs as the installing user (`UserName`).

// POSIX paths whatever machine renders the entry: the scheduler is a POSIX one.
import { dirname, join } from "@std/path/posix";
import type { SchedulerHost } from "./host.ts";
import {
  type Backend,
  type BackendContext,
  check,
  type EntrySpec,
  markedSlug,
  marker,
  xmlEscape,
} from "./spec.ts";
import {
  type CalendarRule,
  type DaySelector,
  ScheduleTranslationError,
  timeGroups,
} from "./translate.ts";

/** One `StartCalendarInterval` dictionary: an absent key matches every value. */
type CalendarInterval = Partial<
  Record<"Month" | "Day" | "Weekday" | "Hour" | "Minute", number>
>;

/** The most calendar dictionaries one entry may hold before the schedule is refused. */
const LAUNCHD_MAX_INTERVALS = 1000;

/** Each value, or one "every value" slot when the list is the whole domain. */
function slots(values: readonly number[] | undefined, domain: number): (number | undefined)[] {
  return !values || values.length === domain ? [undefined] : [...values];
}

/** The day half of the dictionaries a selector needs. */
function dayIntervals(days: DaySelector): CalendarInterval[] {
  const months = slots(days.month, 12);
  const withMonth = (base: CalendarInterval[]) =>
    months.flatMap((m) => base.map((b) => (m === undefined ? b : { Month: m, ...b })));
  const byDom = (days.dom ?? []).map((d): CalendarInterval => ({ Day: d }));
  const byDow = (days.dow ?? []).map((w): CalendarInterval => ({ Weekday: w }));
  if (days.either) return withMonth([...byDom, ...byDow]);
  if (days.dom) return withMonth(byDom);
  if (days.dow) return withMonth(byDow);
  return withMonth([{}]);
}

/** The dictionaries one rule needs. */
function ruleIntervals(rule: CalendarRule): CalendarInterval[] {
  const dayParts = dayIntervals(rule.days);
  return timeGroups(rule.times).flatMap((group) =>
    slots(group.hours, 24).flatMap((hour) =>
      slots(group.minutes, 60).flatMap((minute) =>
        dayParts.map((day) => ({
          ...day,
          ...(hour === undefined ? {} : { Hour: hour }),
          ...(minute === undefined ? {} : { Minute: minute }),
        }))
      )
    )
  );
}

/**
 * The `StartCalendarInterval` dictionaries for some rules.
 *
 * @throws {ScheduleTranslationError} When they need more than {@linkcode LAUNCHD_MAX_INTERVALS}.
 */
export function launchdIntervals(rules: readonly CalendarRule[], crons: readonly string[]) {
  const out = rules.flatMap(ruleIntervals);
  if (out.length > LAUNCHD_MAX_INTERVALS) {
    throw new ScheduleTranslationError(
      `${crons.map((c) => `"${c}"`).join(", ")} needs ${out.length} launchd calendar entries ` +
        `(at most ${LAUNCHD_MAX_INTERVALS}): launchd has no step syntax, so every listed ` +
        `minute and hour is one entry. Use fewer distinct minutes, or "*" for the minute field.`,
    );
  }
  return out;
}

/** The label of a job's entry. */
function launchdLabel(projectId: string, slug: string): string {
  return `dev.denext.job.${projectId}.${slug}`;
}

/** Text safe inside an XML comment (which may not hold `--`). */
function xmlComment(text: string): string {
  return xmlEscape(text).replace(/-(?=-)/g, "- ");
}

/** `<key>k</key><string>v</string>`, indented. */
function stringKey(key: string, value: string, indent = "  "): string {
  return `${indent}<key>${key}</key>\n${indent}<string>${xmlEscape(value)}</string>`;
}

/** One calendar dictionary. */
function intervalXml(interval: CalendarInterval): string {
  const keys = (["Month", "Day", "Weekday", "Hour", "Minute"] as const)
    .filter((k) => interval[k] !== undefined)
    .map((k) => `      <key>${k}</key>\n      <integer>${interval[k]}</integer>`);
  return keys.length === 0 ? "    <dict/>" : `    <dict>\n${keys.join("\n")}\n    </dict>`;
}

/**
 * A job's property list.
 *
 * @param entry The job's entry.
 * @param ctx The project and scope.
 */
function renderLaunchdPlist(entry: EntrySpec, ctx: BackendContext): string {
  const intervals = launchdIntervals(entry.schedule.rules, entry.crons);
  const args = entry.argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
    `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- ${marker(ctx.project.id, entry.slug)} -->`,
    `<!-- ${
      xmlComment(
        `Written by \`denext job install\` for ${ctx.project.dir} (job ${entry.job}: ` +
          `${entry.crons.join("; ")} UTC). Its uninstall flag removes it.`,
      )
    } -->`,
    `<plist version="1.0">`,
    `<dict>`,
    stringKey("Label", launchdLabel(ctx.project.id, entry.slug)),
    `  <key>ProgramArguments</key>\n  <array>\n${args}\n  </array>`,
    stringKey("WorkingDirectory", ctx.project.dir),
    ...(ctx.scope === "system" && ctx.runAs ? [stringKey("UserName", ctx.runAs)] : []),
    `  <key>StartCalendarInterval</key>\n  <array>\n${
      intervals.map(intervalXml).join("\n")
    }\n  </array>`,
    stringKey("StandardOutPath", entry.logFile),
    stringKey("StandardErrorPath", entry.logFile),
    `</dict>`,
    `</plist>`,
    ``,
  ];
  return lines.join("\n");
}

/** Where the entries live, and the launchd domain they load into. */
function place(host: SchedulerHost, ctx: BackendContext): { dir: string; domain: string } {
  return ctx.scope === "system"
    ? { dir: "/Library/LaunchDaemons", domain: "system" }
    : { dir: join(host.home, "Library", "LaunchAgents"), domain: `gui/${host.uid}` };
}

/** This project's property lists in the directory, by slug. */
async function ours(host: SchedulerHost, ctx: BackendContext): Promise<Map<string, string>> {
  const { dir } = place(host, ctx);
  const prefix = launchdLabel(ctx.project.id, "");
  const found = new Map<string, string>();
  for (const name of await host.readDir(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".plist")) continue;
    const path = join(dir, name);
    const slug = markedSlug((await host.readTextFile(path)) ?? "", ctx.project.id);
    if (slug) found.set(slug, path);
  }
  return found;
}

/** Unloads one entry; it not being loaded is fine. */
async function bootout(host: SchedulerHost, domain: string, label: string): Promise<void> {
  await host.run("launchctl", ["bootout", `${domain}/${label}`], { mutates: true });
}

/** The launchd backend. */
export const launchdBackend: Backend = {
  name: "launchd",
  clock: "local",
  validate: (entry) => void launchdIntervals(entry.schedule.rules, entry.crons),
  available: (host) => Promise.resolve(host.os === "darwin"),
  list: async (host, ctx) => [...(await ours(host, ctx)).keys()].sort(),
  install: async (host, ctx, entries) => {
    const { dir, domain } = place(host, ctx);
    const existing = await ours(host, ctx);
    for (const entry of entries) {
      const label = launchdLabel(ctx.project.id, entry.slug);
      const path = join(dir, `${label}.plist`);
      const plist = renderLaunchdPlist(entry, ctx);
      if (existing.has(entry.slug)) await bootout(host, domain, label);
      await host.ensureDir(dirname(entry.logFile));
      await host.writeFile(path, plist);
      check(
        await host.run("launchctl", ["bootstrap", domain, path], { mutates: true }),
        `launchctl bootstrap ${label}`,
      );
    }
  },
  remove: async (host, ctx, slugs) => {
    const { domain } = place(host, ctx);
    const existing = await ours(host, ctx);
    for (const slug of slugs) {
      const path = existing.get(slug);
      if (!path) continue;
      await bootout(host, domain, launchdLabel(ctx.project.id, slug));
      await host.remove(path);
    }
  },
};
