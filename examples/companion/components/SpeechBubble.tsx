// The speech bubble Loopy talks in: the text, up to three buttons, and a close button. It closes
// itself after `message.timeoutMs` (0: only when the user closes it or presses a button).
import { useEffect } from "denext";
import type { LoopyMessage } from "../lib/messages.ts";

/** The props of {@linkcode SpeechBubble}. */
export interface SpeechBubbleProps {
  /** What to say. */
  readonly message: LoopyMessage;
  /** A button was pressed (the bubble is done). */
  readonly onAction: (actionId: string) => void;
  /** The bubble closed: the close button, or its time ran out. */
  readonly onClose: () => void;
}

/** A speech bubble pointing down at Loopy. */
export function SpeechBubble({ message, onAction, onClose }: SpeechBubbleProps) {
  useEffect(() => {
    if (message.timeoutMs <= 0) return;
    const timer = setTimeout(onClose, message.timeoutMs);
    return () => clearTimeout(timer);
  }, [message.id, message.timeoutMs]);

  return (
    <div class="bubble" data-mood={message.mood} role="status" aria-live="polite">
      <button type="button" class="bubble-close" aria-label="Close" onClick={() => onClose()}>
        ×
      </button>
      <p class="bubble-text">{message.text}</p>
      {message.actions.length > 0 && (
        <div class="bubble-actions">
          {message.actions.map((a) => (
            <button
              type="button"
              key={a.id}
              onClick={() => onAction(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
