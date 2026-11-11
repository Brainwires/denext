// Loopy's settings panel: the OpenAI API key (write-only: it can be set, replaced or cleared, never
// shown), each way of starting a voice turn on or off, the tools (web search, the browser, memory)
// on or off, what Loopy remembers (newest first; forget one, or all), and Loopy's size.
"use client";
import { useState } from "denext";
import type { KeyStatus, MemoryItem } from "../lib/voice-backend.ts";
import {
  GLOBAL_SHORTCUT,
  type LoopySettings,
  PUSH_TO_TALK_KEY,
  SCALE,
} from "../lib/voice-settings.ts";

/** The props of {@linkcode VoiceSettings}. */
export interface VoiceSettingsProps {
  readonly settings: LoopySettings;
  readonly onChange: (settings: LoopySettings) => void;
  /** Whether a key is set and where it lives (`null` while asking). */
  readonly status: KeyStatus | null;
  /** Store or replace the key; resolves with a problem to show, or `null`. */
  readonly onSetKey: (key: string) => Promise<string | null>;
  /** Forget the key; resolves with a problem to show, or `null`. */
  readonly onClearKey: () => Promise<string | null>;
  /** Running in the desktop app (the global shortcut is desktop-only). */
  readonly desktop: boolean;
  /** Why the global shortcut could not be registered, if it couldn't. */
  readonly shortcutProblem: string | null;
  /** What Loopy remembers, newest first (`null` while asking). */
  readonly memories?: readonly MemoryItem[] | null;
  /** Forget one memory. */
  readonly onForget?: (id: number) => void;
  /** Forget every memory. */
  readonly onForgetAll?: () => void;
  readonly onClose: () => void;
}

/** One on/off setting. */
function Toggle(
  { label, checked, disabled, note, onChange }: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    note?: string;
    onChange?: (on: boolean) => void;
  },
) {
  return (
    <label class={disabled ? "setting is-disabled" : "setting"}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        // A click flips the controlled box (and reaches the handler in every engine).
        onClick={() => onChange?.(!checked)}
      />
      <span>{label}</span>
      {note && <small>{note}</small>}
    </label>
  );
}

/** What the key section says about the key. */
function keyStatusText(status: KeyStatus | null): string {
  if (status === null) return "Checking…";
  if (status.keySource === "env") {
    return status.hasKey
      ? "Using OPENAI_API_KEY from the dev server."
      : "Set OPENAI_API_KEY in the dev server's environment.";
  }
  return status.hasKey ? "A key is saved in your keychain." : "No key yet.";
}

/** The key form: a password field, Save / Replace, and Clear once a key is set. */
function KeyForm(
  { hasKey, onSave, onClear }: {
    hasKey: boolean;
    onSave: (key: string) => Promise<boolean>;
    onClear: () => void;
  },
) {
  const [draft, setDraft] = useState("");
  return (
    <form
      aria-label="Set the API key"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(draft).then((saved) => saved && setDraft(""));
      }}
    >
      <input
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder={hasKey ? "Paste a new key to replace it" : "sk-…"}
        aria-label="OpenAI API key"
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      />
      <button type="submit" disabled={draft.trim() === ""}>{hasKey ? "Replace" : "Save"}</button>
      {hasKey && <button type="button" onClick={onClear}>Clear</button>}
    </form>
  );
}

/** The API key: a write-only field where it can be set (the keychain), else where it comes from. */
function KeySection(
  { status, onSetKey, onClearKey }: Pick<VoiceSettingsProps, "status" | "onSetKey" | "onClearKey">,
) {
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (key: string) => {
    const p = await onSetKey(key);
    setProblem(p);
    return p === null;
  };
  return (
    <fieldset class="settings-key">
      <legend>OpenAI API key</legend>
      <p class="settings-note">{keyStatusText(status)}</p>
      {status?.keySource === "keychain" && (
        <KeyForm
          hasKey={status.hasKey}
          onSave={save}
          onClear={async () => setProblem(await onClearKey())}
        />
      )}
      {problem && <p class="settings-problem">{problem}</p>}
    </fieldset>
  );
}

/** When a memory was kept, for the list. */
function memoryDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** One memory: when, what the user said and what Loopy answered, and a button to forget it. */
function MemoryRow({ memory, onForget }: { memory: MemoryItem; onForget?: (id: number) => void }) {
  return (
    <li class="memory">
      <time dateTime={new Date(memory.createdAt).toISOString()}>
        {memoryDate(memory.createdAt)}
      </time>
      <span class="memory-user">{memory.user}</span>
      {memory.assistant && <span class="memory-assistant">{memory.assistant}</span>}
      <button
        type="button"
        class="memory-forget"
        aria-label="Forget this"
        title="Forget this"
        onClick={() => onForget?.(memory.id)}
      >
        ×
      </button>
    </li>
  );
}

/** "Forget all", which asks once more before it forgets. */
function ForgetAll({ onForgetAll }: { onForgetAll?: () => void }) {
  const [sure, setSure] = useState(false);
  if (!sure) return <button type="button" onClick={() => setSure(true)}>Forget all</button>;
  return (
    <span class="memory-sure">
      Forget everything?{" "}
      <button
        type="button"
        onClick={() => {
          setSure(false);
          onForgetAll?.();
        }}
      >
        Yes, forget all
      </button>{" "}
      <button type="button" onClick={() => setSure(false)}>Keep</button>
    </span>
  );
}

/** What Loopy remembers. */
function MemorySection(
  { memories, onForget, onForgetAll, on }:
    & Pick<
      VoiceSettingsProps,
      "memories" | "onForget" | "onForgetAll"
    >
    & { on: boolean },
) {
  const note = on
    ? "Each conversation is kept on this computer."
    : "Memory is off: nothing new is kept.";
  return (
    <fieldset class="settings-memory">
      <legend>Memories</legend>
      <p class="settings-note">{note}</p>
      {memories === null || memories === undefined
        ? <p class="settings-note">Loading…</p>
        : memories.length === 0
        ? <p class="settings-note">Nothing remembered.</p>
        : (
          <>
            <ul class="memory-list" aria-label="What Loopy remembers">
              {memories.map((m) => <MemoryRow key={m.id} memory={m} onForget={onForget} />)}
            </ul>
            <ForgetAll onForgetAll={onForgetAll} />
          </>
        )}
    </fieldset>
  );
}

/** Loopy's settings. */
export function VoiceSettings(props: VoiceSettingsProps) {
  const { settings, onChange, desktop, shortcutProblem } = props;
  const set = (patch: Partial<LoopySettings>) => onChange({ ...settings, ...patch });
  return (
    <section class="settings" aria-label="Loopy's settings" data-loopy-hit="">
      <header>
        <h2>Settings</h2>
        <button type="button" class="bubble-close" aria-label="Close" onClick={props.onClose}>
          ×
        </button>
      </header>
      <KeySection status={props.status} onSetKey={props.onSetKey} onClearKey={props.onClearKey} />
      <fieldset>
        <legend>Talk to Loopy</legend>
        <Toggle
          label={`Hold ${PUSH_TO_TALK_KEY} to talk`}
          note="while Loopy's window has the focus"
          checked={settings.pushToTalk}
          onChange={(on) => set({ pushToTalk: on })}
        />
        <Toggle
          label="Click Loopy to talk"
          note="click again to send"
          checked={settings.clickToTalk}
          onChange={(on) => set({ clickToTalk: on })}
        />
        <Toggle
          label={`${GLOBAL_SHORTCUT} from any app`}
          note={desktop
            ? shortcutProblem ?? "press to talk, press again to send"
            : "desktop app only"}
          checked={desktop && settings.globalShortcut}
          disabled={!desktop}
          onChange={(on) => set({ globalShortcut: on })}
        />
        <Toggle label={`"Hey Loopy"`} note="coming soon" checked={false} disabled />
      </fieldset>
      <fieldset>
        <legend>Tools</legend>
        <Toggle
          label="Web search"
          note="answers current questions, with sources"
          checked={settings.webSearch}
          onChange={(on) => set({ webSearch: on })}
        />
        <Toggle
          label="Browser"
          note="opens and drives a Chrome window you can watch; asks before submitting"
          checked={settings.browser}
          onChange={(on) => set({ browser: on })}
        />
        <Toggle
          label="Memory"
          note="remembers your conversations and recalls them"
          checked={settings.memory}
          onChange={(on) => set({ memory: on })}
        />
      </fieldset>
      <MemorySection
        memories={props.memories}
        onForget={props.onForget}
        onForgetAll={props.onForgetAll}
        on={settings.memory}
      />
      <fieldset>
        <legend>Size</legend>
        <label class="setting setting-range">
          <input
            type="range"
            min={SCALE.min}
            max={SCALE.max}
            step={SCALE.step}
            value={settings.scale}
            aria-label="Loopy's size"
            onInput={(e) => set({ scale: Number((e.target as HTMLInputElement).value) })}
          />
          <output>{settings.scale}%</output>
        </label>
      </fieldset>
    </section>
  );
}
