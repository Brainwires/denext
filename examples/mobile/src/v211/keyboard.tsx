// Keyboard: a 2,000-message chat on VirtualList anchor="end" with its composer in
// KeyboardStickyView, a live useKeyboard() readout, and a form in KeyboardAvoidingView.
import { type Ref, useRef, useState, VirtualList, type VirtualListHandle } from "denext";
import {
  hideKeyboard,
  KeyboardAvoidingView,
  KeyboardStickyView,
  useKeyboard,
  useSafeAreaInsets,
} from "denext/mobile";
import { navigate } from "../ui.tsx";
import { Fill, Screen } from "./shell.tsx";

export interface Message {
  id: number;
  mine: boolean;
  text: string;
}

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor"
  .split(" ");

/** `n` messages of varied length (deterministic, so row heights repeat run to run). */
export function makeMessages(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => {
    const len = 3 + ((i * 7919) % 40);
    const text = Array.from(
      { length: len },
      (_, j) => WORDS[(i + j * 3) % WORDS.length],
    ).join(
      " ",
    );
    return { id: i, mine: i % 3 === 0, text: `#${i} ${text}` };
  });
}

export function Bubble({ m }: { m: Message }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: m.mine ? "flex-end" : "flex-start",
      }}
    >
      <div class={m.mine ? "bubble mine" : "bubble"}>{m.text}</div>
    </div>
  );
}

/** The chat thread: newest at the bottom, stays pinned there as messages arrive. */
export function ChatList(
  { messages, listRef }: {
    messages: Message[];
    listRef?: Ref<VirtualListHandle>;
  },
) {
  return (
    <VirtualList
      ref={listRef}
      style={{ height: "100%" }}
      data={messages}
      keyExtractor={(m) => m.id}
      anchor="end"
      estimatedItemSize={56}
      renderItem={(m) => <Bubble m={m} />}
    />
  );
}

export function KeyboardScreen() {
  const kb = useKeyboard();
  const { bottom } = useSafeAreaInsets();
  const [messages, setMessages] = useState(() => makeMessages(2000));
  const [draft, setDraft] = useState("");
  const list = useRef<VirtualListHandle>(null);
  const send = () => {
    if (!draft.trim()) return;
    setMessages((
      prev,
    ) => [...prev, { id: prev.length, mine: true, text: draft }]);
    setDraft("");
  };
  return (
    <Screen
      fill
      insetBottom={false}
      title="Keyboard"
      todo="Tap the composer: it rides on top of the keyboard, the readout shows visible: true and a height > 0, and the list stays pinned to the newest message. Send a message: it appears at the bottom. Fling up through history: momentum never stops mid-fling. 'Form' opens the KeyboardAvoidingView form."
    >
      <div class="kb-readout btn-row" data-selftest="kb-readout">
        useKeyboard(): visible <strong>{String(kb.visible)}</strong> · height{" "}
        <strong>{Math.round(kb.height)}</strong>
        {kb.animationDuration !== undefined && ` · ${kb.animationDuration} ms`}{"  "}
        <button type="button" onClick={() => navigate("/v211/keyboard-form")}>
          Form
        </button>
        <button type="button" onClick={() => void hideKeyboard()}>Hide</button>
      </div>
      <Fill data-selftest="chat-body">
        <ChatList messages={messages} listRef={list} />
      </Fill>
      {/* In the flow under the list; above the home indicator while the keyboard is hidden. */}
      <KeyboardStickyView
        data-selftest="composer"
        style={{
          display: "flex",
          gap: "8px",
          padding: `8px 8px ${8 + (kb.visible ? 0 : bottom)}px`,
          background: "Canvas",
          borderTop: "1px solid color-mix(in srgb, CanvasText 20%, transparent)",
        }}
      >
        <input
          value={draft}
          placeholder="Message"
          enterKeyHint="send"
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button type="button" onClick={send}>Send</button>
      </KeyboardStickyView>
    </Screen>
  );
}

export function KeyboardFormScreen() {
  const kb = useKeyboard();
  return (
    <Screen
      fill
      title="Keyboard: avoiding form"
      todo="Tap the LAST field (Notes): the form pads itself so the field and the Save button stay above the keyboard, not hidden behind it."
    >
      <Fill>
        <KeyboardAvoidingView
          behavior="padding"
          style={{
            height: "100%",
            overflowY: "auto",
            padding: "12px",
            boxSizing: "border-box",
          }}
        >
          <p class="note">
            keyboard visible: {String(kb.visible)} · height {Math.round(kb.height)}
          </p>
          <div>
            {[
              "Name",
              "Email",
              "Phone",
              "Street",
              "City",
              "Postcode",
              "Country",
              "Notes",
            ].map((f) => (
              <label key={f} style={{ display: "block", margin: "0 0 14px" }}>
                {f}
                <input placeholder={f} />
              </label>
            ))}
          </div>
          <button type="button" onClick={() => void hideKeyboard()}>Save</button>
        </KeyboardAvoidingView>
      </Fill>
    </Screen>
  );
}
