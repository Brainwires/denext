// The speech bubble during a voice turn: what the user said (live transcription), then what Loopy
// says (the live transcript of its voice), or what is going on while neither has text yet; the
// links a web search found, which open in the user's browser; and a tool's question with Yes / No
// (a form submit in Loopy's browser waits for it). Pure: app/companion.tsx holds the voice state
// (lib/voice-machine.ts).
import type { VoiceModel } from "../lib/voice-machine.ts";

/** What the bubble says while there is no transcript yet. */
const PLACEHOLDERS: Partial<Record<VoiceModel["phase"], string>> = {
  connecting: "Waking up…",
  listening: "Listening…",
  thinking: "Hmm…",
};

/** The props of {@linkcode VoiceBubble}. */
export interface VoiceBubbleProps {
  readonly voice: VoiceModel;
  /** The close button. */
  readonly onClose: () => void;
  /** The user's answer to the question (Yes / No). */
  readonly onAnswer?: (approved: boolean) => void;
  /** Open a source link in the user's browser. */
  readonly onOpenLink?: (url: string) => void;
}

/** Whether the voice turn has anything to show in a bubble. */
export function voiceBubbleShown(voice: VoiceModel): boolean {
  return voice.user !== "" || voice.assistant !== "" || voice.error !== null ||
    voice.question !== null || voice.sources.length > 0 ||
    PLACEHOLDERS[voice.phase] !== undefined;
}

/** The links a tool found; a click opens one in the user's browser, not in Loopy's window. */
function Sources(
  { sources, onOpenLink }: Pick<VoiceModel, "sources"> & Pick<VoiceBubbleProps, "onOpenLink">,
) {
  if (sources.length === 0) return null;
  return (
    <ul class="bubble-sources" aria-label="Sources">
      {sources.map((s) => (
        <li key={s.url}>
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={s.url}
            onClick={(e) => {
              if (!onOpenLink) return;
              e.preventDefault();
              onOpenLink(s.url);
            }}
          >
            {s.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A tool's question and the two answers. */
function Question(
  { question, onAnswer }: { question: string; onAnswer?: (approved: boolean) => void },
) {
  return (
    <div class="bubble-question" role="group" aria-label="Loopy asks">
      <p class="bubble-text">{question}</p>
      <div class="bubble-actions">
        <button type="button" onClick={() => onAnswer?.(true)}>Yes</button>
        <button type="button" onClick={() => onAnswer?.(false)}>No</button>
      </div>
    </div>
  );
}

/** The bubble for the voice turn on screen. */
export function VoiceBubble({ voice, onClose, onAnswer, onOpenLink }: VoiceBubbleProps) {
  const placeholder =
    voice.user === "" && voice.assistant === "" && voice.error === null && voice.question === null
      ? PLACEHOLDERS[voice.phase]
      : undefined;
  return (
    <div
      class="bubble voice-bubble"
      data-mood={voice.mood ?? "neutral"}
      data-voice={voice.phase}
      data-loopy-hit=""
      role="status"
      aria-live="polite"
    >
      <button type="button" class="bubble-close" aria-label="Close" onClick={() => onClose()}>
        ×
      </button>
      {voice.user !== "" && <p class="bubble-user">{voice.user}</p>}
      {voice.assistant !== "" && <p class="bubble-text">{voice.assistant}</p>}
      {voice.question !== null && <Question question={voice.question} onAnswer={onAnswer} />}
      <Sources sources={voice.sources} onOpenLink={onOpenLink} />
      {voice.error !== null && <p class="bubble-error">{voice.error}</p>}
      {placeholder && <p class="bubble-text bubble-status">{placeholder}</p>}
    </div>
  );
}
