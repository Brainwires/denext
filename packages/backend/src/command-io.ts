// Where the plugin's CLI verbs print (injectable for tests).

/** The output side of a verb. */
export interface CommandIo {
  log(line: string): void;
  error(line: string): void;
  exit(code: number): void;
  /** Ask a yes/no question at the terminal; absent when there is no terminal to ask at. */
  confirm?(question: string): Promise<boolean>;
}

/** Whether stdin is a terminal (`false` without the permission to tell). */
function stdinIsTerminal(): boolean {
  try {
    return Deno.stdin.isTerminal();
  } catch {
    return false;
  }
}

/** The console and `Deno.exit` (and the terminal's `[y/N]`, when there is one). */
export const consoleIo: CommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  exit: (code) => Deno.exit(code),
  ...(stdinIsTerminal()
    ? { confirm: (question: string) => Promise.resolve(globalThis.confirm(question)) }
    : {}),
};
