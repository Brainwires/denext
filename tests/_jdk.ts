// The Java-compiling tests (the Android halves of the native templates, compiled with javac against
// plain-JDK stand-ins and run with java). Locally they are skipped without a JDK; under CI they are
// never skipped: the job installs one (actions/setup-java), and a missing JDK fails the test
// instead of hiding it.

function runs(tool: string): boolean {
  try {
    return new Deno.Command(tool, { args: ["-version"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
}

/** Whether `javac` and `java` are on PATH. */
const HAS_JDK: boolean = runs("javac") && runs("java");

/** The `ignore` for a Java-compiling test: only off CI, and only without a JDK. */
export const IGNORE_WITHOUT_JDK: boolean = !HAS_JDK && !Deno.env.get("CI");

/** Fail (under CI) when the JDK is missing, rather than skip. */
export function requireJdk(): void {
  if (!HAS_JDK) {
    throw new Error(
      "javac / java not found: a CI job running this test must install a JDK (actions/setup-java)",
    );
  }
}
