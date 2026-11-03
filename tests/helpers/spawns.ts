// Capture the children code under test spawns, for a test that must wait for one the code never
// hands back (a detached warm-up, a run that rejects while its child is still exiting): the op /
// resource sanitizers (on in deno.json) fail a test that ends with a child still running.

/**
 * Run `fn`, capturing every child `Deno.Command#spawn` starts meanwhile.
 *
 * @param fn The code under test.
 * @returns The children it spawned, in order.
 */
export async function spawnsOf(fn: () => Promise<unknown>): Promise<Deno.ChildProcess[]> {
  const Original = Deno.Command;
  const spawned: Deno.ChildProcess[] = [];
  class Capturing extends Original {
    override spawn(): Deno.ChildProcess {
      const child = super.spawn();
      spawned.push(child);
      return child;
    }
  }
  Object.defineProperty(Deno, "Command", { value: Capturing, configurable: true, writable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(Deno, "Command", { value: Original, configurable: true, writable: true });
  }
  return spawned;
}

/**
 * Wait for each child to exit (an unref'd one is ref'd first, so the wait keeps the loop alive).
 *
 * @param children The children.
 */
export async function exited(children: readonly Deno.ChildProcess[]): Promise<void> {
  for (const child of children) {
    child.ref();
    await child.status;
  }
}
