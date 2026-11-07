// Linux without a systemd user manager: the user's crontab. Each job is one block between two
// marker lines, so a re-install replaces exactly that block and an uninstall removes exactly ours;
// every other line of the crontab is kept byte for byte. cron reads its lines in local time, so
// the schedule is the translated one.

import { dirname } from "@std/path";
import type { SchedulerHost } from "./host.ts";
import { type Backend, type BackendContext, check, type EntrySpec, marker } from "./spec.ts";
import { type CalendarRule, timeGroups } from "./translate.ts";

/** A comma list, or `*` for the whole domain. */
function list(values: readonly number[] | undefined, domain: number): string {
  return !values || values.length === domain ? "*" : values.join(",");
}

/** The five time fields of each line some rules need. */
function crontabFields(rules: readonly CalendarRule[]): string[] {
  return rules.flatMap((rule) =>
    timeGroups(rule.times).map((g) =>
      [
        list(g.minutes, 60),
        list(g.hours, 24),
        list(rule.days.dom, 31),
        list(rule.days.month, 12),
        list(rule.days.dow, 7),
      ].join(" ")
    )
  );
}

/** One word for `sh`, single-quoted; `%` escaped (cron turns a bare one into a newline). */
function shWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`.replace(/%/g, "\\%");
}

/** The line that opens a job's block. */
function openLine(projectId: string, slug: string): string {
  return `# >>> ${marker(projectId, slug)}`;
}

/** The line that closes it. */
function closeLine(projectId: string, slug: string): string {
  return `# <<< ${marker(projectId, slug)}`;
}

/**
 * A job's crontab block.
 *
 * @param entry The job's entry.
 * @param ctx The project.
 */
function renderCrontabBlock(entry: EntrySpec, ctx: BackendContext): string {
  const command = `cd ${shWord(ctx.project.dir)} && ${entry.argv.map(shWord).join(" ")} ` +
    `>> ${shWord(entry.logFile)} 2>&1`;
  return [
    openLine(ctx.project.id, entry.slug),
    `# denext job ${entry.job.replace(/[\r\n]/g, " ")} (${entry.crons.join("; ")} UTC)`,
    ...crontabFields(entry.schedule.rules).map((fields) => `${fields} ${command}`),
    closeLine(ctx.project.id, entry.slug),
  ].join("\n");
}

/** The slugs of this project's blocks in a crontab. */
export function crontabSlugs(text: string, projectId: string): string[] {
  const open = `# >>> denext-managed project=${projectId} job=`;
  return text.split("\n").filter((line) => line.startsWith(open)).map((line) =>
    line.slice(open.length).trim()
  ).sort();
}

/**
 * The crontab without this project's blocks for `slugs`, every other line kept.
 *
 * @param text The crontab.
 * @param projectId The project.
 * @param slugs The blocks to drop.
 */
export function withoutBlocks(text: string, projectId: string, slugs: readonly string[]): string {
  const drop = new Set(slugs.map((slug) => openLine(projectId, slug)));
  const out: string[] = [];
  let closing: string | null = null;
  for (const line of text.split("\n")) {
    if (closing !== null) {
      if (line === closing) closing = null;
      continue;
    }
    if (drop.has(line)) {
      closing = line.replace("# >>> ", "# <<< ");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** `text` ending in exactly one newline (cron ignores a last line without one). */
function terminated(text: string): string {
  const body = text.replace(/\n+$/, "");
  return body === "" ? "" : `${body}\n`;
}

/** The user's crontab, `""` when they have none; `null` when there is no `crontab`. */
async function readCrontab(host: SchedulerHost): Promise<string | null> {
  const result = await host.run("crontab", ["-l"]);
  if (result.code === 0) return result.stdout;
  if (result.code === 127) return null;
  // "no crontab for <user>": an empty one.
  if (/no crontab/i.test(result.stderr)) return "";
  check(result, "crontab -l");
  return null;
}

/** Writes the crontab when it changed. */
async function writeCrontab(host: SchedulerHost, before: string, after: string): Promise<void> {
  if (terminated(after) === terminated(before)) return;
  check(await host.run("crontab", ["-"], { stdin: terminated(after), mutates: true }), "crontab -");
}

/** The crontab backend (user scope only). */
export const crontabBackend: Backend = {
  name: "crontab",
  clock: "local",
  validate: () => {},
  available: async (host, ctx) =>
    host.os !== "windows" && ctx.scope === "user" && (await readCrontab(host)) !== null,
  list: async (host, ctx) => crontabSlugs((await readCrontab(host)) ?? "", ctx.project.id),
  install: async (host, ctx, entries) => {
    const before = (await readCrontab(host)) ?? "";
    const kept = withoutBlocks(before, ctx.project.id, entries.map((e) => e.slug));
    const blocks = entries.map((entry) => renderCrontabBlock(entry, ctx));
    for (const dir of new Set(entries.map((entry) => dirname(entry.logFile)))) {
      await host.ensureDir(dir);
    }
    await writeCrontab(
      host,
      before,
      [terminated(kept).replace(/\n$/, ""), ...blocks]
        .filter((part) => part !== "").join("\n"),
    );
  },
  remove: async (host, ctx, slugs) => {
    const before = (await readCrontab(host)) ?? "";
    await writeCrontab(host, before, withoutBlocks(before, ctx.project.id, slugs));
  },
};
