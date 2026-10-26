// `/database/realtime` — realtime, from both sides:
//
//   - the database (through the `db-admin` child): the publication tables opt in through, each
//     table's place in it, its `denext_realtime` triggers, key and RLS — and the one write, adding
//     a table to the publication or dropping it, previewed and run like every other write;
//   - the running app (through the backend's admin endpoint, behind the secret key): its live
//     channels with their subscriber counts and every `postgres_changes` binding's table, filter
//     and events.
//
// `/database/realtime/presence` lists a live topic's presence KEYS only; one key's tracked
// payloads are shown only when an operator expands that key (a link of its own).

import {
  Badge,
  type DbRealtimeTable,
  type DbReplies,
  h,
  Mono,
  Note,
  OpForm,
  Out,
  Table,
  type VNode,
} from "@denext/denext/internal/ui-host";
import type { UiContext } from "../html.ts";
import { adminPresence, type AdminStatus, adminStatus, appTarget } from "../app-admin.ts";
import { knownSecrets, redact } from "../logs/source.ts";
import { ConfirmView, href, StatementBlock, type ViewCtx } from "./database-views.ts";
import { answer, applying, ask, failure, field, page, seeOther, viewCtx } from "./database-kit.ts";

/** The longest topic or presence key the page passes on. */
const MAX_NAME = 255;

/** What a finished opt-in reports (`?done=`). */
const DONE: Record<string, string> = {
  added: "Added the table to the publication: the running app creates its triggers shortly.",
  dropped: "Dropped the table from the publication: the running app drops its triggers shortly.",
};

/** A table's opt-in action: a preview form (none for a table realtime cannot take). */
function optIn(
  { ctx, table, publication }: {
    readonly ctx: ViewCtx;
    readonly table: DbRealtimeTable;
    readonly publication: string | null;
  },
): VNode | null {
  if (publication === null) return null;
  if (!table.inPublication && table.primaryKeyColumns !== 1) {
    return h("span", { class: "lead" }, "needs a one-column primary key");
  }
  const action = table.inPublication ? "drop" : "add";
  return h(OpForm, {
    csrf: ctx.csrf,
    action: "/database/realtime",
    label: table.inPublication ? "Remove from publication…" : "Add to publication…",
    fields: { op: "preview", action, schema: table.schema, table: table.name },
    disabled: ctx.readOnly,
  });
}

/** The database half: the publication and each table. */
function TablesView(
  { ctx, state }: { readonly ctx: ViewCtx; readonly state: DbReplies["realtimeTables"] },
): VNode {
  const rows = state.tables.map((t) =>
    h(
      "tr",
      { key: `${t.schema}.${t.name}` },
      h("td", null, h(Mono, null, `${t.schema}.${t.name}`)),
      h("td", null, t.configured ? h(Badge, { tone: "ok" }, "realtime({ tables })") : ""),
      h(
        "td",
        null,
        t.inPublication ? h(Badge, { tone: "ok" }, "in publication") : h(Badge, null, "not in"),
      ),
      h(
        "td",
        null,
        t.triggerEvents.length
          ? t.triggerEvents.join(", ")
          : h(Badge, { tone: "info" }, "no triggers"),
      ),
      h("td", null, t.rls ? h(Badge, { tone: "ok" }, "RLS") : h(Badge, { tone: "warn" }, "no RLS")),
      h("td", null, optIn({ ctx, table: t, publication: state.publication })),
    )
  );
  const pub = state.publication === null
    ? "Tables opt in through realtime({ tables }) only (publication: false)."
    : [
      "Tables opt in through the publication ",
      h(Mono, null, state.publication),
      state.publicationExists ? "" : " (not created yet: adding a table creates it)",
      ", as a Supabase migration's alter publication … add table does.",
    ];
  return h(
    "div",
    null,
    h(
      "p",
      { class: "lead" },
      state.configured
        ? `Realtime is configured (source: ${state.source}). `
        : "This project configures no realtime (backend({ realtime })): its publication is Supabase's default. ",
      pub,
    ),
    rows.length
      ? h(
        "div",
        { class: "table-scroll" },
        h(Table, { head: ["Table", "Configured", "Publication", "Triggers", "", ""], rows }),
      )
      : h(Note, null, "No tables."),
  );
}

/** The running app's half: live channels and `postgres_changes` bindings. */
function LiveView(
  { live, secrets }: {
    readonly live: AdminStatus["realtime"] | string;
    readonly secrets: readonly string[];
  },
): VNode {
  if (typeof live === "string") return h(Note, null, live);
  if (live === null) return h(Note, null, "The running app has no realtime socket on.");
  const channels = live.channels.map((c) =>
    h(
      "tr",
      { key: `${c.private}:${c.topic}` },
      h("td", null, h(Mono, null, c.topic)),
      h("td", null, c.private ? h(Badge, { tone: "info" }, "private") : "public"),
      h("td", null, String(c.subscribers)),
      h(
        "td",
        null,
        h("a", {
          href: href("/database/realtime/presence", {
            topic: c.topic,
            private: c.private ? "1" : undefined,
          }),
        }, "Presence keys"),
      ),
    )
  );
  const bindings = live.bindings.map((b, index) =>
    h(
      "tr",
      { key: index },
      h("td", null, h(Mono, null, b.topic)),
      h("td", null, b.tables.join(", ")),
      h("td", null, b.filter === null ? "" : h(Mono, null, redact(b.filter, secrets))),
      h("td", null, b.events.join(", ")),
    )
  );
  return h(
    "div",
    null,
    h("p", { class: "lead" }, `${live.connections} open socket(s) on this instance.`),
    channels.length
      ? h(Table, { head: ["Channel", "", "Subscribers", ""], rows: channels })
      : h(Note, null, "No live channels."),
    h("h2", null, "postgres_changes subscribers"),
    bindings.length
      ? h(Table, { head: ["Channel", "Table", "Filter", "Events"], rows: bindings })
      : h(Note, null, "No postgres_changes subscriptions."),
  );
}

/** The running app's realtime, or why it cannot be read. */
async function liveRealtime(ctx: UiContext): Promise<AdminStatus["realtime"] | string> {
  const target = await appTarget(ctx);
  if (!target) return "No running app: start the dev server (or the stack) to see live channels.";
  const status = await adminStatus(target, ctx.signal);
  return status.ok ? status.realtime : status.reason;
}

/**
 * `GET /database/realtime`.
 *
 * @param ctx The request.
 * @returns The page.
 */
export async function realtimePage(ctx: UiContext): Promise<Response> {
  const [reply, live, secrets] = await Promise.all([
    ask<"realtimeTables">(ctx, { op: "realtimeTables" }),
    liveRealtime(ctx),
    knownSecrets(ctx.dir),
  ]);
  const done = DONE[ctx.url.searchParams.get("done") ?? ""];
  return answer(ctx, "/database/realtime", reply, (ok) =>
    h(
      "div",
      null,
      done ? h(Note, { tone: "ok" }, done) : null,
      h("h2", null, "Tables"),
      h(TablesView, { ctx: viewCtx(ctx), state: ok }),
      h("h2", null, "Live channels"),
      h(LiveView, { live, secrets }),
    ));
}

/**
 * `POST /database/realtime`: preview or run adding a table to the publication, or dropping it.
 *
 * @param ctx The request.
 * @returns The confirm page, or the 303 once it ran.
 */
export async function realtimeWrite(ctx: UiContext): Promise<Response> {
  const action = field(ctx, "action") === "drop" ? "drop" : "add";
  const schema = field(ctx, "schema");
  const table = field(ctx, "table");
  const apply = applying(ctx);
  const reply = await ask<"realtimePublication">(ctx, {
    op: "realtimePublication",
    schema,
    table,
    action,
    confirm: apply,
  });
  if (apply && reply.ok && !ctx.json) {
    return seeOther(`/database/realtime?done=${action === "add" ? "added" : "dropped"}`);
  }
  return answer(ctx, "/database/realtime", reply, (ok) =>
    h(ConfirmView, {
      ctx: viewCtx(ctx),
      what: action === "add"
        ? `Add ${schema}.${table} to realtime's publication?`
        : `Drop ${schema}.${table} from realtime's publication?`,
      body: ok.statements.map((statement, index) => h(StatementBlock, { key: index, statement })),
      action: "/database/realtime",
      fields: { action, schema, table },
      cancel: "/database/realtime",
      label: action === "add" ? "Add to publication" : "Drop from publication",
    }));
}

/** The presence keys of a topic, each with an explicit link to expand its payload. */
function KeysView(
  { topic, isPrivate, keys }: {
    readonly topic: string;
    readonly isPrivate: boolean;
    readonly keys: Record<string, number>;
  },
): VNode {
  const rows = Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) =>
    h(
      "tr",
      { key },
      h("td", null, h(Mono, null, key)),
      h("td", null, String(count)),
      h(
        "td",
        null,
        h("a", {
          href: href("/database/realtime/presence", {
            topic,
            private: isPrivate ? "1" : undefined,
            key,
          }),
        }, "Show payload"),
      ),
    )
  );
  return rows.length
    ? h(Table, { head: ["Presence key", "Presences", ""], rows })
    : h(Note, null, "No presence on this channel.");
}

/**
 * `GET /database/realtime/presence?topic=&private=[&key=]`: a topic's presence keys — or, with
 * `key`, that key's tracked payloads, which the page shows only when asked for this way.
 *
 * @param ctx The request.
 * @returns The page.
 */
export async function presencePage(ctx: UiContext): Promise<Response> {
  const topic = field(ctx, "topic");
  const isPrivate = field(ctx, "private") === "1";
  const keyParam = ctx.url.searchParams.get("key");
  if (topic === "" || topic.length > MAX_NAME || (keyParam?.length ?? 0) > MAX_NAME) {
    return answer(
      ctx,
      "/database/realtime",
      failure("bad_request", "a topic of at most 255 characters"),
      () => h("div", null),
    );
  }
  const target = await appTarget(ctx);
  const result = target
    ? await adminPresence(target, topic, isPrivate, keyParam, ctx.signal)
    : { ok: false as const, reason: "No running app: start the dev server (or the stack)." };
  if (ctx.json) {
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const back = h(
    "p",
    { class: "lead" },
    h("a", { href: "/database/realtime" }, "« Realtime"),
    " · ",
    h(Mono, null, topic),
    keyParam === null ? null : [
      " · ",
      h("a", {
        href: href("/database/realtime/presence", { topic, private: isPrivate ? "1" : undefined }),
      }, "« Keys"),
    ],
  );
  if (!result.ok) {
    return page(ctx, "/database/realtime", [back, h(Note, { role: "alert" }, result.reason)]);
  }
  if (keyParam === null) {
    return page(ctx, "/database/realtime", [
      back,
      h(KeysView, { topic, isPrivate, keys: result.keys ?? {} }),
    ]);
  }
  const secrets = await knownSecrets(ctx.dir);
  return page(ctx, "/database/realtime", [
    back,
    h("p", { class: "lead" }, "What each presence under ", h(Mono, null, keyParam), " tracked:"),
    h(Out, null, redact(JSON.stringify(result.payloads ?? [], null, 2), secrets)),
  ]);
}
