# Loopy for Claude Code

Two [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks) that make Loopy pop up
when a session needs you and when it finishes:

- **`Notification`** — Claude Code needs permission for a tool, or has been waiting for your input.
  Loopy unbends to point at its bubble and repeats Claude Code's message, prefixed with the
  project's folder name.
- **`Stop`** — the session finished its turn. Loopy hops: "Claude Code finished in _project_."

Both run [`scripts/loopy-say.ts`](../scripts/loopy-say.ts) with `--from-hook`, which reads the
hook's JSON from stdin (`hook_event_name`, `message`, `cwd`) and posts the message to Loopy's inbox.
When Loopy isn't running the script prints why and exits 1, which Claude Code reports and otherwise
ignores (only exit code 2 blocks).

## Set it up

1. Start Loopy (`denext task desktop` in `examples/companion`). Its first run creates the inbox file
   with a random token; the app prints where.
2. Copy the `hooks` block of [`hooks.json`](./hooks.json) into a Claude Code settings file — your
   project's `.claude/settings.json` (or `.claude/settings.local.json` to keep it to yourself), or
   your user settings if you want Loopy for every project — and replace `/path/to/denext` with this
   checkout's path. Merge it with any `hooks` you already have.
3. Check it without Claude Code:

   ```sh
   echo '{"hook_event_name":"Stop","cwd":"/tmp/demo"}' | deno run --allow-read --allow-env --allow-net=127.0.0.1 scripts/loopy-say.ts --from-hook
   ```

The permissions are the script's whole reach: read the inbox file, read the variables that locate
it, and connect to `127.0.0.1`. Nothing in this folder edits your settings for you.
