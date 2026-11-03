// A project's installed `@capacitor/cli`, as the `cap` runners look for it before running
// `npx --no cap …` (they never let npx fetch a registry `cap`).

import { join } from "@std/path";

/**
 * Write `node_modules/@capacitor/cli/package.json` under `root`, so the `cap` steps find the
 * project's own Capacitor CLI.
 *
 * @param root The Capacitor project (or a folder above it).
 */
export async function installFakeCapacitorCli(root: string): Promise<void> {
  const dir = join(root, "node_modules", "@capacitor", "cli");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@capacitor/cli", version: "8.5.2", bin: { cap: "bin/capacitor" } }),
  );
}

/**
 * npm publish times where every version is years old: `denext mobile add`'s dependency-age check
 * passes without reaching the registry.
 */
export const oldPublishTimes = (_name: string): Promise<Readonly<Record<string, string>>> =>
  Promise.resolve(new Proxy({}, { get: () => "2020-01-01T00:00:00.000Z" }));
