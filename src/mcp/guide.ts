// The AI-authoring guide denext ships (the MCP `denext://guide` resource, the docs corpus,
// `llms-full.txt`) is AGENTS.md MINUS its repo-process tail: the release flow, the coverage
// and fallow gates are instructions for people (and agents) working ON denext, not for
// writing denext apps — shipping them would tell every consumer to run our commit hooks.

/** The first H2 of AGENTS.md that is repo process, not app-authoring guidance. */
const REPO_PROCESS_MARKER = "\n## Releasing:";

/** `AGENTS.md` cut before its repo-process sections (release flow, coverage/fallow gates). */
export function publicGuide(agentsMd: string): string {
  const cut = agentsMd.indexOf(REPO_PROCESS_MARKER);
  return (cut === -1 ? agentsMd : agentsMd.slice(0, cut)).trimEnd() + "\n";
}
