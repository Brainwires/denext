// The help text of `denext generate` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../generate.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { GENERATE_KINDS } from "../../../build/generate.ts";
import { DOCKER_FLAGS } from "../generate-docker.ts";

/** `denext generate`. */
export const generateMeta: CommandMeta = {
  name: "generate",
  summary:
    "Scaffold a route, boundary, component, API route, action, middleware, job, Edge Function, test, Docker setup, migration, vector search, seed, CI workflow or monorepo app",
  aliases: ["g"],
  loadsModules: false,
  // pure codegen — no user-module load / re-exec needed
  usage: "  denext generate page dashboard/settings\n" +
    "  denext generate layout dashboard\n" +
    "  denext generate loading dashboard # app/dashboard/loading.tsx (root if no path)\n" +
    "  denext generate error dashboard   # app/dashboard/error.tsx (Client Component)\n" +
    "  denext generate not-found         # app/not-found.tsx\n" +
    "  denext generate component UserCard\n" +
    "  denext generate api users\n" +
    "  denext generate action createPost\n" +
    "  denext generate middleware        # middleware.ts (beside app/)\n" +
    "  denext generate job cleanup      # jobs/cleanup.ts (defineJob)\n" +
    "  denext generate function hello   # functions/hello/index.ts (an Edge Function)\n" +
    "  denext generate test UserCard     # tests/UserCard.test.tsx (denext/testing)\n" +
    "  denext generate docker            # Dockerfile + docker-compose.yml + .dockerignore\n" +
    "  denext generate docker spa        # force the static/SPA image (else auto-detected)\n" +
    "  denext generate docker --stack    # + Postgres 17, MinIO, migrations, .env.example\n" +
    "  denext generate docker --postgres --pgvector --no-storage --dev --dry-run\n" +
    "  denext generate migration add_users # migrations/<UTC stamp>_add_users.sql (+ jobs/migrate.ts)\n" +
    "  denext generate vector-search documents # pgvector table + match_documents (a migration)\n" +
    "  denext generate seed              # jobs/seed.ts (node:sqlite, or Prisma when detected)\n" +
    "  denext generate ci                # .github/workflows/ci.yml (check + build)\n" +
    "  denext generate app admin         # apps/admin in a `denext create --monorepo` workspace",
  flags: [
    { name: "force", type: "boolean", help: "Overwrite files that already exist" },
    {
      name: "dry-run",
      type: "boolean",
      help: "Print what would be written (docker: a diff per file) and write nothing",
    },
    ...DOCKER_FLAGS,
  ],
  positionals: [
    { name: "kind", help: GENERATE_KINDS.join(" | "), required: true },
    {
      name: "name",
      help: "Route/component/action/migration name (docker: server|spa; seed: sqlite|prisma; " +
        "ci: github — each optional)",
    },
    { name: "dir", help: "Project directory (default: .)" },
  ],
};
