// `denext ota channel <name> <dir>` and `denext ota promote`: edit the channels file that
// `createOtaHandler({ channels })` serves OTA releases from (src/build/ota-channels.ts).

import { resolve } from "@std/path";
import type { CommandContext } from "../command.ts";
import {
  DEFAULT_OTA_CHANNELS_FILE,
  promoteOtaRelease,
  setOtaChannel,
} from "../../build/ota-channels.ts";
import type { OtaChannelsFile } from "../../server/ota-rollout.ts";

/** Print `message` to stderr and exit 1. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

/** A string flag's value, or undefined. */
function stringFlag(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") fail(`denext ota: --${name} needs a value`);
  return value;
}

/** The channels file path, resolved against the working directory. */
function channelsFile(ctx: CommandContext): string {
  return resolve(ctx.global.cwd ?? ".", stringFlag(ctx, "file") ?? DEFAULT_OTA_CHANNELS_FILE);
}

/** Print the resulting file, as JSON or one line per channel. */
function printChannels(ctx: CommandContext, file: string, doc: OtaChannelsFile): void {
  if (ctx.global.json) {
    console.log(JSON.stringify({ file, ...doc }));
    return;
  }
  console.log(`  wrote ${file}`);
  for (const [name, channel] of Object.entries(doc.channels)) {
    const rollout = channel.rollout
      ? `, rolling out ${channel.rollout.release} to ${channel.rollout.percent}%`
      : "";
    const fallback = name === doc.default ? " (default)" : "";
    console.log(`  ${name}${fallback}: ${channel.release}${rollout}`);
  }
}

/** `denext ota channel <name> <dir>`. */
export async function otaChannel(ctx: CommandContext): Promise<void> {
  const [, channel, release] = ctx.positionals;
  if (!channel || !release) {
    fail(
      "denext ota channel: pass the channel and the export, e.g. `denext ota channel beta out`.",
    );
  }
  const file = channelsFile(ctx);
  try {
    const doc = await setOtaChannel({
      file,
      channel,
      release: resolve(ctx.global.cwd ?? ".", release),
      force: ctx.flags.force === true,
    });
    printChannels(ctx, file, doc);
  } catch (err) {
    fail(`denext ota channel: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `denext ota promote (--channel <c> | --release <dir>) --to <c> [--percent n] [--halt]`. */
export async function otaPromote(ctx: CommandContext): Promise<void> {
  const to = stringFlag(ctx, "to");
  if (!to) fail("denext ota promote: pass the target channel with --to <name>.");
  const channel = stringFlag(ctx, "channel");
  const release = stringFlag(ctx, "release");
  if (channel && release) fail("denext ota promote: pass --channel or --release, not both.");
  const percent = ctx.flags.percent;
  if (percent !== undefined && typeof percent !== "number") {
    fail("denext ota promote: --percent takes a number");
  }
  const file = channelsFile(ctx);
  try {
    const doc = await promoteOtaRelease({
      file,
      to,
      ...(channel ? { from: { channel } } : {}),
      ...(release ? { from: { release: resolve(ctx.global.cwd ?? ".", release) } } : {}),
      ...(percent === undefined ? {} : { percent }),
      halt: ctx.flags.halt === true,
      force: ctx.flags.force === true,
    });
    printChannels(ctx, file, doc);
  } catch (err) {
    fail(`denext ota promote: ${err instanceof Error ? err.message : String(err)}`);
  }
}
