// Windows: one Task Scheduler task per job, registered from XML with `schtasks /Create /XML`
// under the folder `\denext\<project id>\`. Calendar triggers run in local time, so the schedule
// is the translated one: each evenly spaced run of times is one trigger with a repetition
// interval, on a daily, weekly or monthly calendar. A user task runs while that user is logged
// on; a system one whether they are or not (S4U, the same account, no stored password).

import { join } from "@std/path";
import type { SchedulerHost } from "./host.ts";
import {
  type Backend,
  type BackendContext,
  check,
  type EntrySpec,
  marker,
  pad2,
  xmlEscape,
} from "./spec.ts";
import {
  type CalendarRule,
  type DaySelector,
  ScheduleTranslationError,
  timeRuns,
} from "./translate.ts";

/** Task Scheduler's limit on one task's triggers. */
const SCHTASKS_MAX_TRIGGERS = 48;

/** The weekday elements, indexed by the POSIX number (0 = Sunday). */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The month elements, indexed from 1. */
const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `<Months>` for a month list (every month when absent). */
function monthsXml(months: readonly number[] | undefined): string {
  const all = months ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  return `<Months>${all.map((m) => `<${MONTH_NAMES[m]} />`).join("")}</Months>`;
}

/** `<DaysOfWeek>` for weekdays. */
function weekdaysXml(dow: readonly number[]): string {
  return `<DaysOfWeek>${dow.map((d) => `<${DAY_NAMES[d]} />`).join("")}</DaysOfWeek>`;
}

/** The schedule element for weekdays (and months). */
function weekdaySchedule(dow: readonly number[], months: readonly number[] | undefined): string {
  if (!months) {
    return `<ScheduleByWeek><WeeksInterval>1</WeeksInterval>${weekdaysXml(dow)}</ScheduleByWeek>`;
  }
  const weeks = ["1", "2", "3", "4", "Last"].map((w) => `<Week>${w}</Week>`).join("");
  return `<ScheduleByMonthDayOfWeek><Weeks>${weeks}</Weeks>${weekdaysXml(dow)}${
    monthsXml(months)
  }</ScheduleByMonthDayOfWeek>`;
}

/** The schedule element for days of the month (and months). */
function monthDaySchedule(dom: readonly number[], months: readonly number[] | undefined): string {
  const days = dom.map((d) => `<Day>${d}</Day>`).join("");
  return `<ScheduleByMonth><DaysOfMonth>${days}</DaysOfMonth>${
    monthsXml(months)
  }</ScheduleByMonth>`;
}

/** The schedule elements a selector needs (two for Vixie's either-day rule). */
function scheduleElements(days: DaySelector): string[] {
  const out: string[] = [];
  if (days.dom) out.push(monthDaySchedule(days.dom, days.month));
  if (days.dow) out.push(weekdaySchedule(days.dow, days.month));
  if (out.length > 0) return out;
  if (days.month) {
    const all = Array.from({ length: 31 }, (_, i) => i + 1);
    return [monthDaySchedule(all, days.month)];
  }
  return ["<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>"];
}

/** The calendar triggers for some rules. */
function taskTriggers(rules: readonly CalendarRule[], crons: readonly string[]): string[] {
  const triggers = rules.flatMap((rule) =>
    timeRuns(rule.times).flatMap((run) => {
      const at = `2000-01-01T${pad2(Math.floor(run.start / 60))}:${pad2(run.start % 60)}:00`;
      const repetition = run.count > 1
        ? `<Repetition><Interval>PT${run.step}M</Interval><Duration>PT${
          (run.count - 1) * run.step + 1
        }M</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`
        : "";
      return scheduleElements(rule.days).map((schedule) =>
        `    <CalendarTrigger>${repetition}<StartBoundary>${at}</StartBoundary>` +
        `<Enabled>true</Enabled>${schedule}</CalendarTrigger>`
      );
    })
  );
  if (triggers.length > SCHTASKS_MAX_TRIGGERS) {
    throw new ScheduleTranslationError(
      `${crons.map((c) => `"${c}"`).join(", ")} needs ${triggers.length} Task Scheduler ` +
        `triggers (at most ${SCHTASKS_MAX_TRIGGERS}): each run of evenly spaced times is one ` +
        `trigger. Space the minute and hour fields evenly (a step such as */15), or list fewer.`,
    );
  }
  return triggers;
}

/** One argument as `CommandLineToArgvW` reads it back. */
export function windowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += "\\".repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** The task's folder for a project. */
function folder(projectId: string): string {
  return `\\denext\\${projectId}\\`;
}

/** The task name of a job's entry. */
function taskName(projectId: string, slug: string): string {
  return `${folder(projectId)}${slug}`;
}

/** The account the task runs as. */
function account(host: SchedulerHost): string {
  const user = host.env("USERNAME") ?? "";
  const domain = host.env("USERDOMAIN");
  return domain ? `${domain}\\${user}` : user;
}

/**
 * A job's task definition.
 *
 * @param entry The job's entry.
 * @param ctx The project and scope.
 * @param userId The account (`DOMAIN\user`).
 */
function renderTaskXml(entry: EntrySpec, ctx: BackendContext, userId: string): string {
  const [command, ...args] = entry.argv;
  const description = `${marker(ctx.project.id, entry.slug)}. denext job ${entry.job} for ` +
    `${ctx.project.dir} (${entry.crons.join("; ")} UTC); \`denext job install --uninstall\` ` +
    `removes it.`;
  const logon = ctx.scope === "system" ? "S4U" : "InteractiveToken";
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Author>denext</Author>`,
    `    <Description>${xmlEscape(description)}</Description>`,
    `    <URI>${xmlEscape(taskName(ctx.project.id, entry.slug))}</URI>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    ...taskTriggers(entry.schedule.rules, entry.crons),
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${xmlEscape(userId)}</UserId>`,
    `      <LogonType>${logon}</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    // A run still going when the next is due is left alone: denext never overlaps a job.
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <StartWhenAvailable>false</StartWhenAvailable>`,
    `    <Enabled>true</Enabled>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${xmlEscape(command)}</Command>`,
    `      <Arguments>${xmlEscape(args.map(windowsArg).join(" "))}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(ctx.project.dir)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

/** `text` as UTF-16LE with a byte-order mark: what `schtasks /XML` reads reliably. */
function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[2 + i * 2] = unit & 0xff;
    out[3 + i * 2] = unit >> 8;
  }
  return out;
}

/** The first CSV field of a `schtasks /Query /FO CSV /NH` line. */
function firstCsvField(line: string): string {
  const match = /^"((?:[^"]|"")*)"/.exec(line.trim());
  return match ? match[1].replace(/""/g, '"') : "";
}

/** The slugs of this project's tasks in a `schtasks /Query /FO CSV /NH` listing. */
export function taskSlugs(listing: string, projectId: string): string[] {
  const prefix = folder(projectId).toLowerCase();
  const slugs = new Set<string>();
  for (const line of listing.split(/\r?\n/)) {
    const name = firstCsvField(line);
    if (!name.toLowerCase().startsWith(prefix)) continue;
    const slug = name.slice(prefix.length);
    if (/^[A-Za-z0-9_-]+$/.test(slug)) slugs.add(slug);
  }
  return [...slugs].sort();
}

/** The Task Scheduler backend. */
export const schtasksBackend: Backend = {
  name: "schtasks",
  clock: "local",
  validate: (entry) => void taskTriggers(entry.schedule.rules, entry.crons),
  available: (host) => Promise.resolve(host.os === "windows"),
  list: async (host, ctx) => {
    const result = await host.run("schtasks", ["/Query", "/FO", "CSV", "/NH"]);
    check(result, "schtasks /Query");
    return taskSlugs(result.stdout, ctx.project.id);
  },
  install: async (host, ctx, entries) => {
    const userId = account(host);
    for (const entry of entries) {
      const xmlPath = join(ctx.project.stateDir, "job-install", `${entry.slug}.xml`);
      await host.writeFile(xmlPath, utf16le(renderTaskXml(entry, ctx, userId)));
      const name = taskName(ctx.project.id, entry.slug);
      const result = await host.run("schtasks", ["/Create", "/TN", name, "/XML", xmlPath, "/F"], {
        mutates: true,
      });
      await host.remove(xmlPath);
      check(result, `schtasks /Create ${name}`);
    }
  },
  remove: async (host, ctx, slugs) => {
    for (const slug of slugs) {
      const name = taskName(ctx.project.id, slug);
      check(
        await host.run("schtasks", ["/Delete", "/TN", name, "/F"], { mutates: true }),
        `schtasks /Delete ${name}`,
      );
    }
  },
};
