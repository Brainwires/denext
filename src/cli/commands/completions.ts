// `denext completions <bash|zsh|fish>` — emit a shell completion script generated
// from the live registry (verb names + summaries), so completions never drift from
// the actual command set. Built via a factory that closes over the registry, since
// the verb list is only known at assembly time.
//
//   bash:  source <(denext completions bash)
//   zsh:   denext completions zsh > "${fpath[1]}/_denext"
//   fish:  denext completions fish > ~/.config/fish/completions/denext.fish

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

/** Build the `completions` verb bound to `reg` (so it lists the real verb set). */
export function makeCompletionsCommand(reg: CommandRegistry): CommandSpec {
  return {
    name: "completions",
    summary: "Print a shell completion script (bash|zsh|fish)",
    positionals: [{ name: "shell", help: "bash | zsh | fish", required: true }],
    run: (ctx) => {
      const shell = ctx.positionals[0];
      switch (shell) {
        case "bash":
          console.log(bashScript(reg));
          return;
        case "zsh":
          console.log(zshScript(reg));
          return;
        case "fish":
          console.log(fishScript(reg));
          return;
        default:
          console.error(
            `denext completions: unknown shell "${shell ?? ""}" (expected bash | zsh | fish).`,
          );
          Deno.exit(1);
      }
    },
  };
}
