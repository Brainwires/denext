// Loopy's settings panel: the OpenAI API key (write-only: it can be set, replaced or cleared, never
// shown), each way of starting a voice turn on or off, and Loopy's size.
"use client";
import { useState } from "denext";
import type { KeyStatus } from "../lib/voice-backend.ts";
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
