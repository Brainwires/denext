// `denext completions <bash|zsh|fish>` — emit a shell completion script generated
// from the live registry (verb names + summaries), so completions never drift from
// the actual command set. Built via a factory that closes over the registry, since
// the verb list is only known at assembly time.
//
//   bash:  source <(denext completions bash)
//   zsh:   denext completions zsh > "${fpath[1]}/_denext"
//   fish:  denext completions fish > ~/.config/fish/completions/denext.fish
//
// The project's own verbs are the ones the last `denext commands` recorded (`.denext/commands.json`,
// trusted only while the files it read are unchanged), merged in by `cli.ts` without importing
// the project: a completion script is sourced from a shell rc file, so it runs whenever a
// terminal opens — in an untrusted clone too — and must never run the project's config or a
// plugin's `setup`. Run `denext commands` once in a project to complete its verbs.
//
// The Deno verbs the CLI forwards (`denext compile`, `denext x`, …) are listed too, after the
// denext and project verbs, with Deno's own summaries: a name a denext or project verb already
// has is not forwarded, so it is not offered twice.

import type { CommandRegistry, CommandSpec } from "../command.ts";
import { forwardedDenoVerbs } from "../deno-verbs.ts";
import { commandMeta } from "../command-meta.ts";

/** One completion row: a verb and its one-line summary. */
interface Row {
  readonly name: string;
  readonly summary: string;
}

/** The visible (non-hidden) registered verbs, then the forwarded Deno verbs. */
function rows(reg: CommandRegistry): Row[] {
  const own = reg.list().filter((c) => !c.hidden)
    .map((c) => ({ name: c.name, summary: c.summary }));
  const deno = forwardedDenoVerbs((name) => reg.get(name) !== undefined)
    .map((v) => ({ name: v.name, summary: `deno ${v.name}: ${v.summary}` }));
  return [...own, ...deno];
}

/** Every completable verb name, sorted. */
function verbs(reg: CommandRegistry): string[] {
  return rows(reg).map((row) => row.name).sort();
}

/** A plain action word (what a completion may offer unquoted). */
const ACTION = /^[a-z][a-z0-9-]*$/;

/**
 * A verb's actions — the words its first positional's help lists as `a | b | c` (`denext db
 * <migrate | rollback | …>`), offered as the second word's completions.
 *
 * @param spec The verb.
 * @returns The actions, or none.
 */
export function actionsOf(spec: CommandSpec): string[] {
  const words = (spec.positionals?.[0]?.help ?? "").split(" | ").map((w) => w.trim());
  return words.length > 1 && words.every((w) => ACTION.test(w)) ? words : [];
}

/** Every visible verb (and alias) with actions: `[name, actions]`. */
function verbActions(reg: CommandRegistry): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const spec of reg.list()) {
    if (spec.hidden || !ACTION.test(spec.name)) continue;
    const actions = actionsOf(spec);
    if (!actions.length) continue;
    for (const name of [spec.name, ...(spec.aliases ?? [])]) {
      if (ACTION.test(name)) out.push([name, actions]);
    }
  }
  return out;
}

/** A summary made safe for a single-quoted shell string. */
function quoted(summary: string): string {
  return summary.replace(/'/g, "");
}

function bashScript(reg: CommandRegistry): string {
  const names = verbs(reg).join(" ");
  const cases = verbActions(reg)
    .map(([name, actions]) =>
      `      ${name}) COMPREPLY=( $(compgen -W "${actions.join(" ")}" -- "$cur") ) ;;`
    )
    .join("\n");
  return `# denext bash completions — source <(denext completions bash)
_denext_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") )
  elif [ "$COMP_CWORD" -eq 2 ]; then
    case "\${COMP_WORDS[1]}" in
${cases}
    esac
  fi
}
complete -F _denext_complete denext
`;
}

function zshScript(reg: CommandRegistry): string {
  const lines = rows(reg)
    .map((row) => `    '${row.name}:${quoted(row.summary)}'`)
    .join("\n");
  const cases = verbActions(reg)
    .map(([name, actions]) => `    ${name}) compadd -- ${actions.join(" ")} ;;`)
    .join("\n");
  return `#compdef denext
# denext zsh completions — denext completions zsh > "\${fpath[1]}/_denext"
_denext() {
  local -a commands
  commands=(
${lines}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  (( CURRENT == 3 )) || return
  case $words[2] in
${cases}
  esac
}
_denext "$@"
`;
}

function fishScript(reg: CommandRegistry): string {
  const verbLines = rows(reg)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) =>
      `complete -c denext -n __fish_use_subcommand -a ${row.name} -d '${quoted(row.summary)}'`
    );
  const actionLines = verbActions(reg).map(([name, actions]) =>
    `complete -c denext -n '__fish_seen_subcommand_from ${name}' -a '${actions.join(" ")}'`
  );
  return [...verbLines, ...actionLines].join("\n") + "\n";
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
    ...commandMeta("completions"),
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
      Deno.exit(0);
    },
  };
}
