// The app: a controlled composer (denext fills it in from the shell itself) and a notes editor
// that takes its shell state with `useShellHandoff` and restores the selection after the swap.
import { shellReady, useLayoutEffect, useRef, useShellHandoff, useState } from "denext";
import { Layout } from "./layout.tsx";

export function App() {
  const [text, setText] = useState("");
  const notes = useShellHandoff("notes");
  const notesRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = notesRef.current!;
    if (notes) el.textContent = notes.text;
    el.dataset.handoff = notes ? `${notes.selectionStart}-${notes.selectionEnd}` : "none";
    shellReady().then(() => {
      document.documentElement.dataset.swapped = "1";
      if (!notes?.focused || !el.firstChild) return;
      el.focus();
      const range = document.createRange();
      range.setStart(el.firstChild, notes.selectionStart);
      range.setEnd(el.firstChild, notes.selectionEnd);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    });
  }, []);
  return (
    <Layout title="Composer" marker="app">
      <div className="notes" contentEditable data-denext-shell-key="notes" ref={notesRef} />
      <textarea
        className="composer"
        placeholder="Ask anything"
        data-denext-shell-key="composer"
        value={text}
        onChange={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <output data-testid="state">{text}</output>
    </Layout>
  );
}
