// The speech bubble during a voice turn: what the user said (live transcription), then what Loopy
// says (the live transcript of its voice), or what is going on while neither has text yet.
// Pure: app/companion.tsx holds the voice state (lib/voice-machine.ts).
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
}

/** Whether the voice turn has anything to show in a bubble. */
export function voiceBubbleShown(voice: VoiceModel): boolean {
  return voice.user !== "" || voice.assistant !== "" || voice.error !== null ||
    PLACEHOLDERS[voice.phase] !== undefined;
}

/** The bubble for the voice turn on screen. */
export function VoiceBubble({ voice, onClose }: VoiceBubbleProps) {
  const placeholder = voice.user === "" && voice.assistant === "" && voice.error === null
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
      {voice.error !== null && <p class="bubble-error">{voice.error}</p>}
      {placeholder && <p class="bubble-text bubble-status">{placeholder}</p>}
    </div>
  );
}
