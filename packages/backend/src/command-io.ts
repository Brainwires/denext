// Where the plugin's CLI verbs print (injectable for tests).

/** The output side of a verb. */
export interface CommandIo {
  log(line: string): void;
  error(line: string): void;
  exit(code: number): void;
}

/** The console and `Deno.exit`. */
export const consoleIo: CommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  exit: (code) => Deno.exit(code),
};
