// `denext completions <bash|zsh|fish>` — emit a shell completion script generated
// from the live registry (verb names + summaries), so completions never drift from
// the actual command set. Built via a factory that closes over the registry, since
// the verb list is only known at assembly time.
//
//   bash:  source <(denext completions bash)
//   zsh:   denext completions zsh > "${fpath[1]}/_denext"
//   fish:  denext completions fish > ~/.config/fish/completions/denext.fish
//
// Completions are the one listing that still discovers the PROJECT's verbs eagerly (a shell
// can only complete a name it was given), so `cli.ts` merges them in first, under the
// {@link COMMAND_LOAD_BUDGET_MS} budget — a plugin `setup` that hangs costs 1.5 s and the
// script is emitted without that project's verbs. Because that same `setup` is arbitrary user
// code that may leave a timer or a watcher open, this verb always `Deno.exit`s once the script
// is on stdout: a leaked handle must never keep the shell's completion call alive.

import type { CommandRegistry, CommandSpec } from "../command.ts";

/** Visible (non-hidden) verb names, sorted. */
function verbs(reg: CommandRegistry): string[] {
  return reg.list().filter((c) => !c.hidden).map((c) => c.name).sort();
}

function bashScript(reg: CommandRegistry): string {
  const names = verbs(reg).join(" ");
  return `# denext bash completions — source <(denext completions bash)
_denext_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") )
  fi
}
complete -F _denext_complete denext
`;
}

function zshScript(reg: CommandRegistry): string {
  const lines = reg.list()
    .filter((c) => !c.hidden)
    .map((c) => `    '${c.name}:${c.summary.replace(/'/g, "")}'`)
    .join("\n");
  return `#compdef denext
# denext zsh completions — denext completions zsh > "\${fpath[1]}/_denext"
_denext() {
  local -a commands
  commands=(
${lines}
  )
  _describe 'command' commands
}
_denext "$@"
`;
}

function fishScript(reg: CommandRegistry): string {
  return verbs(reg)
    .map((n) => {
      const c = reg.get(n)!;
      return `complete -c denext -n __fish_use_subcommand -a ${n} -d '${
        c.summary.replace(/'/g, "")
      }'`;
    })
    .join("\n") + "\n";
}

/** The script emitters, keyed by the shell name the verb accepts. */
const emit: Record<string, (reg: CommandRegistry) => string> = {
  bash: bashScript,
  zsh: zshScript,
  fish: fishScript,
};

/** Build the `completions` verb bound to `reg` (so it lists the real verb set). */
export function makeCompletionsCommand(reg: CommandRegistry): CommandSpec {
  return {
    name: "completions",
    summary: "Print a shell completion script (bash|zsh|fish)",
    positionals: [{ name: "shell", help: "bash | zsh | fish", required: true }],
    run: (ctx) => {
      const shell = ctx.positionals[0];
      const script = emit[shell ?? ""];
      if (!script) {
        console.error(
          `denext completions: unknown shell "${shell ?? ""}" (expected bash | zsh | fish).`,
        );
        Deno.exit(1);
      }
      console.log(script(reg));
      // Eager project-verb discovery ran a plugin `setup`; exit rather than wait on whatever
      // handle it may have left open (see the module header).
      Deno.exit(0);
    },
  };
}
