// Capture the exact environment a benchmark run happened in. Every report is
// only as reproducible as this header — pinned runtime + dependency versions,
// machine, and a timestamp — so it is emitted verbatim at the top of each run.

export interface Provenance {
  timestamp: string;
  deno: string;
  v8: string;
  typescript: string;
  os: string;
  arch: string;
  cpu: string;
  cores: number;
  /** Filled by the runner from the Next fixture's installed versions. */
  node?: string;
  next?: string;
  react?: string;
}

function cpuModel(): string {
  try {
    // Best-effort; not all platforms expose this the same way.
    if (Deno.build.os === "darwin") {
      const out = new Deno.Command("sysctl", {
        args: ["-n", "machdep.cpu.brand_string"],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      return new TextDecoder().decode(out.stdout).trim() || "unknown";
    }
  } catch {
    // ignore — fall through to unknown
  }
  return "unknown";
}

export function captureProvenance(now: string): Provenance {
  return {
    timestamp: now,
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    typescript: Deno.version.typescript,
    os: Deno.build.os,
    arch: Deno.build.arch,
    cpu: cpuModel(),
    cores: navigator.hardwareConcurrency,
  };
}

/** Read Node's version, if Node is on PATH (needed for the Next.js layers). */
export async function nodeVersion(): Promise<string | undefined> {
  try {
    const out = await new Deno.Command("node", {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return undefined;
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return undefined;
  }
}
