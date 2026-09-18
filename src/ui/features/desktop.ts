// `/desktop` — what this project needs in order to ship a signed desktop build, and which of it
// this machine already has.
//
// The packaging scripts (`scripts/package-*.ts`, written by `denext create --desktop`) have
// always been driven by `DENEXT_*` environment variables, and nothing ever told you what to put
// in them. This panel answers that: it lists the signing identities actually in your keychain,
// says which variables are set, and composes the exact command to run.
//
// It never accepts, stores or displays a secret. Of the six variables the scripts read, exactly
// one is a true secret — `DENEXT_WINDOWS_CERT_PASSWORD` — and it has no field here. The macOS
// identity and notary profile are NAMES: the private key and the credentials stay in the
// keychain, so reading those values is safe and showing them is the point. The password is
// probed with `Deno.env.has` and never read, which makes that distinction a property of the
// code rather than a promise in a comment.
//
// Read-only: this panel runs no build and writes no file. Every probe is a local query.

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import { Badge, type BadgeTone, Mono, Note, Out, Panel, Table, Tabs } from "../components.ts";
import { renderView } from "../view.ts";
import { uiSafeJoin } from "../security.ts";
import { hasCommand, listSigningIdentities, type SigningIdentity } from "../signing.ts";

/** The three platforms `denext desktop package` knows, in tab order. */
const TABS = ["macos", "windows", "linux"] as const;

/** One of {@linkcode TABS}. */
type DesktopTab = typeof TABS[number];

/** What each tab is called in the strip. */
const TAB_LABEL: Record<DesktopTab, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** The scaffolded packaging script per platform — its absence is what "not set up" means. */
const SCRIPT: Record<DesktopTab, string> = {
  macos: "scripts/package-macos.ts",
  windows: "scripts/package-windows.ts",
  linux: "scripts/package-linux.ts",
};

/** One environment variable the packaging scripts read. */
interface EnvVar {
  /** Its name. */
  readonly name: string;
  /** What it does, in one line. */
  readonly purpose: string;
  /**
   * A true secret, so its value is never read — only whether it is set. Exactly one variable in
   * this table is one; the rest are names, paths and a URL.
   */
  readonly secret?: true;
}

/** What each tab's script reads, in the order the tab presents it. */
const VARS: Record<DesktopTab, readonly EnvVar[]> = {
  macos: [
    {
      name: "DENEXT_CODESIGN_IDENTITY",
      purpose: "The Developer ID Application identity to sign with. Unset means an ad-hoc " +
        "signature: the app runs here, and Gatekeeper blocks it on every other Mac.",
    },
    {
      name: "DENEXT_NOTARY_PROFILE",
      purpose: "An `xcrun notarytool store-credentials` profile name. Set it to notarize and " +
        "staple; the credentials stay in your keychain.",
    },
    {
      name: "DENEXT_ENTITLEMENTS",
      purpose: "Path to an entitlements .plist. Optional — Screen Recording and Accessibility " +
        "are TCC prompts, not entitlements.",
    },
  ],
  windows: [
    {
      name: "DENEXT_WINDOWS_CERT",
      purpose: "Path to a .pfx code-signing certificate. Unset means the build is not signed.",
    },
    {
      name: "DENEXT_WINDOWS_CERT_PASSWORD",
      purpose: "The .pfx password. This panel never asks for it and never shows it — set it in " +
        "your own shell or CI.",
      secret: true,
    },
    {
      name: "DENEXT_SIGN_TIMESTAMP_URL",
      purpose: "RFC-3161 timestamp server. Defaults to DigiCert's when unset.",
    },
  ],
  linux: [],
};

/** What the panel resolved for one request. */
interface DesktopState {
  /** The project directory. */
  readonly dir: string;
  /** The tab being shown. */
  readonly tab: DesktopTab;
  /** Whether this tab's packaging script exists — false means the project is not set up. */
  readonly scaffolded: boolean;
  /** Each variable and its current state in the UI process's environment. */
  readonly env: readonly EnvState[];
  /** Developer ID identities in this machine's keychain (macOS tab only). */
  readonly identities: readonly SigningIdentity[];
  /** Whether the platform's signing tool is on PATH, or `null` when there is nothing to probe. */
  readonly tool: ToolState | null;
  /** True when packaging this tab's platform cannot run on this host. */
  readonly wrongHost: boolean;
}

/** One variable's current state. */
interface EnvState {
  /** The variable. */
  readonly spec: EnvVar;
  /** Whether it is set in the UI process's environment. */
  readonly set: boolean;
  /** Its value — `null` for a secret, which is never read, and for an unset variable. */
  readonly value: string | null;
}

/** A signing tool's presence. */
interface ToolState {
  /** The program. */
  readonly name: string;
  /** Whether it is on PATH. */
  readonly present: boolean;
  /** Why it matters. */
  readonly purpose: string;
}

/** Lists the Developer ID identities the panel offers. */
export type SigningIdentitySource = () => Promise<readonly SigningIdentity[]>;

/** The identity source this panel uses. */
let identitySource: SigningIdentitySource = () => listSigningIdentities();

/**
 * Swap the signing-identity source.
 *
 * @internal Test seam only: the suite renders both the "none found" guidance and the identities
 * table without depending on what the host's keychain holds. Passing nothing restores the real
 * `security find-identity` probe.
 * @param source The replacement, or `undefined` to restore the default.
 */
export function setSigningIdentitySource(source?: SigningIdentitySource): void {
  identitySource = source ?? (() => listSigningIdentities());
}

/**
 * Whether `name` is set, and its value when reading one is safe.
 *
 * A secret's value is never read — `Deno.env.has` answers the only question worth asking about
 * it. Both calls are guarded: a partial `--allow-env` reads as "not set" rather than throwing,
 * the same posture `env-scan.ts` takes.
 */
function envState(spec: EnvVar): EnvState {
  try {
    if (spec.secret) return { spec, set: Deno.env.has(spec.name), value: null };
    const value = Deno.env.get(spec.name) ?? "";
    return { spec, set: value !== "", value: value === "" ? null : value };
  } catch {
    return { spec, set: false, value: null };
  }
}

/** Which view this request is for — `?tab=`, or macOS when it says nothing recognisable. */
function tabOf(ctx: UiContext): DesktopTab {
  const asked = ctx.url.searchParams.get("tab");
  return TABS.includes(asked as DesktopTab) ? asked as DesktopTab : "macos";
}

/** Whether `rel` exists inside the project (containment enforced, absence is not an error). */
async function exists(dir: string, rel: string): Promise<boolean> {
  try {
    await Deno.stat(await uiSafeJoin(dir, rel));
    return true;
  } catch {
    return false; // missing, or a path that tried to leave the project
  }
}

/** The tool each platform signs with, and whether it is installed. */
async function toolOf(tab: DesktopTab): Promise<ToolState | null> {
  if (tab === "macos") {
    return {
      name: "codesign",
      present: await hasCommand("codesign"),
      purpose: "signs the bundle; ships with the Xcode command line tools",
    };
  }
  if (tab === "windows") {
    return {
      name: "signtool",
      present: await hasCommand("signtool"),
      purpose: "signs the .exe; ships with the Windows SDK",
    };
  }
  return null; // Linux artifacts are not signed at all
}

/** Everything one request needs. */
async function readState(ctx: UiContext): Promise<DesktopState> {
  const tab = tabOf(ctx);
  return {
    dir: ctx.dir,
    tab,
    scaffolded: await exists(ctx.dir, SCRIPT[tab]),
    env: VARS[tab].map(envState),
    identities: tab === "macos" ? await identitySource() : [],
    tool: await toolOf(tab),
    wrongHost: tab === "macos" && Deno.build.os !== "darwin",
  };
}

// ── views ────────────────────────────────────────────────────────────────────

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Desktop", "/desktop");

/** The tab strip, with the current view marked. */
function DesktopTabs({ tab }: { readonly tab: DesktopTab }): VNode {
  return h(Tabs, {
    items: TABS.map((name) => ({
      href: name === "macos" ? "/desktop" : `/desktop?tab=${name}`,
      label: TAB_LABEL[name],
    })),
    active: tab === "macos" ? "/desktop" : `/desktop?tab=${tab}`,
    label: "Desktop platforms",
  });
}

/** The whole `<section id="panel">` — the piece `ui.js` swaps. */
function DesktopPanel({ state }: { readonly state: DesktopState }): VNode {
  return h(
    Panel,
    { name: "Desktop", title: "Desktop" },
    h(
      "p",
      { class: "lead" },
      "Set up code signing for ",
      h("span", { class: "mono" }, state.dir),
      ". This panel reads what your machine has and composes the command; it runs no build and " +
        "writes no file. ",
      h("a", { href: "https://denext.dev/docs/ui#desktop" }, "Desktop ↗"),
    ),
    h(DesktopTabs, { tab: state.tab }),
    state.scaffolded ? null : h(NotScaffolded, { state }),
    state.wrongHost
      ? h(
        Note,
        { role: "alert" },
        "Packaging for macOS only runs on macOS — the script shells out to codesign and " +
          "notarytool. You can still set the variables here.",
      )
      : null,
    state.tab === "linux" ? h(LinuxNote, null) : null,
    state.tab === "macos" ? h(Identities, { state }) : null,
    state.env.length > 0 ? h(EnvTable, { state }) : null,
    state.tool ? h(ToolNote, { tool: state.tool }) : null,
    state.scaffolded ? h(Command, { state }) : null,
  );
}

/** The project was never scaffolded for desktop, so none of the rest applies yet. */
function NotScaffolded({ state }: { readonly state: DesktopState }): VNode {
  return h(
    Note,
    null,
    "No ",
    h(Mono, null, SCRIPT[state.tab]),
    " in this project — it was not created with desktop packaging. Scaffold it with ",
    h(Mono, null, "denext create --desktop"),
    ", then this tab can set it up.",
  );
}

/** Linux artifacts carry no signature at all, which is worth saying plainly. */
function LinuxNote(): VNode {
  return h(
    Note,
    null,
    "Linux packaging produces a .tar.gz (and optionally an AppImage). There is no signing step " +
      "and no certificate to configure.",
  );
}

/** The identities this machine holds — the answer to "what do I put in that variable". */
function Identities({ state }: { readonly state: DesktopState }): VNode {
  if (state.identities.length === 0) {
    return h(
      Note,
      null,
      "No Developer ID Application identity in this keychain. Xcode → Settings → Accounts → " +
        "Manage Certificates → + → Developer ID Application creates one. An Apple Development " +
        "certificate is not enough: it cannot sign a build for distribution.",
    );
  }
  return h(
    "div",
    null,
    h("h2", null, "Identities in your keychain"),
    h(
      "p",
      { class: "lead" },
      "Copy one of these into ",
      h(Mono, null, "DENEXT_CODESIGN_IDENTITY"),
      ". Only Developer ID Application certificates are listed — an Apple Development one cannot " +
        "sign a build for distribution, and a build signed with it loses its permission grants " +
        "on every rebuild.",
    ),
    h(Table, {
      head: ["identity", "team", "fingerprint"],
      rows: state.identities.map((id) =>
        h(
          "tr",
          { key: id.sha1 },
          h("td", null, h(Mono, null, id.name)),
          h("td", null, id.team ?? "—"),
          h("td", null, h(Mono, null, id.sha1)),
        )
      ),
    }),
  );
}

/** Each variable, whether it is set, and what it does. */
function EnvTable({ state }: { readonly state: DesktopState }): VNode {
  return h(
    "div",
    null,
    h("h2", null, "Environment"),
    h(
      "p",
      { class: "lead" },
      "What ",
      h(Mono, null, SCRIPT[state.tab]),
      " reads, as this UI's own environment has it.",
    ),
    h(Table, {
      head: ["variable", "state", "what it does"],
      rows: state.env.map((entry) => h(EnvRow, { key: entry.spec.name, entry })),
    }),
  );
}

/** One variable's row. A secret shows whether it is set and nothing else, ever. */
function EnvRow({ entry }: { readonly entry: EnvState }): VNode {
  const tone: BadgeTone = entry.set ? "ok" : entry.spec.secret ? "info" : "todo";
  const label = entry.set ? "set" : "unset";
  return h(
    "tr",
    null,
    h("td", null, h(Mono, null, entry.spec.name)),
    h(
      "td",
      null,
      h(Badge, { tone }, label),
      entry.value === null ? null : h("div", null, h(Mono, null, entry.value)),
    ),
    h("td", null, entry.spec.purpose),
  );
}

/** Whether the platform's signing tool is installed. */
function ToolNote({ tool }: { readonly tool: ToolState }): VNode {
  if (tool.present) {
    return h(Note, null, h(Mono, null, tool.name), " is on PATH — ", tool.purpose, ".");
  }
  return h(
    Note,
    { role: "alert" },
    h(Mono, null, tool.name),
    " is not on PATH, so signing will be skipped: it ",
    tool.purpose,
    ".",
  );
}

/**
 * `value` as one POSIX-shell word: single-quoted, with each `'` spelled `'\''`. Single quotes
 * are the only quoting a shell expands nothing inside — a `"…"` still runs `$(…)` and
 * `` `…` `` — and a keychain identity's name is text the panel did not write, pasted into a
 * shell by the person reading it.
 *
 * @internal Exported for its unit test.
 * @param value The text to quote.
 * @returns The shell word.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command to run, composed from what this tab resolved. */
function Command({ state }: { readonly state: DesktopState }): VNode {
  const first = state.identities[0];
  // One line per variable that is not set yet, in the order the tab presents them. The identity
  // is the one denext can answer for you, when the keychain holds an answer; the secret is named
  // so you know to set it, and says where it stays.
  const lines = state.env.filter((entry) => !entry.set).map((entry) => {
    if (entry.spec.name === "DENEXT_CODESIGN_IDENTITY" && first !== undefined) {
      return `export ${entry.spec.name}=${shellQuote(first.name)}`;
    }
    if (entry.spec.secret) return `export ${entry.spec.name}=...   # yours; never stored here`;
    return `export ${entry.spec.name}=...`;
  });
  lines.push(
    `denext desktop package${state.tab === "macos" ? "" : ` --target-os ${state.tab}`}`,
  );
  return h(
    "div",
    null,
    h("h2", null, "Run it"),
    h(
      "p",
      { class: "lead" },
      "Set what is missing in your own shell, then package. Nothing here is written to disk.",
    ),
    h(Out, null, lines.join("\n")),
  );
}

// ── the handler ──────────────────────────────────────────────────────────────

/**
 * Serve `/desktop`: the signing setup for one platform, or its JSON twin.
 *
 * @param _request The request (unused — everything comes from the context).
 * @param ctx The kernel's request context.
 * @returns The panel, or the JSON payload for `/api/desktop`.
 */
export const desktopPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  const state = await readState(ctx);
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      tab: state.tab,
      scaffolded: state.scaffolded,
      wrongHost: state.wrongHost,
      identities: state.identities,
      tool: state.tool,
      // A secret's value is absent here too: the JSON twin says whether it is set, never what.
      env: state.env.map((entry) => ({
        name: entry.spec.name,
        set: entry.set,
        secret: entry.spec.secret === true,
        value: entry.value,
      })),
    });
  }
  return panelResponse(
    ctx,
    renderView(h(DesktopPanel, { state })),
    200,
    `Desktop · ${TAB_LABEL[state.tab]}`,
  );
};
