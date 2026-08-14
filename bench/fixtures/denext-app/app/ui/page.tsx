// UI route — real Radix UI (`@radix-ui/react-dialog`, a headless component
// library) + `lucide-react` icons on denext's React. The dialog trigger is
// server-rendered; opening it is a client interaction after hydration.
import { createElement as h } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Info, X } from "lucide-react";

const overlay = "position:fixed;inset:0;background:rgba(0,0,0,.4)";
const content =
  "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:1.5rem;border-radius:.5rem;min-width:20rem;box-shadow:0 10px 40px rgba(0,0,0,.2)";
const trigger =
  "display:inline-flex;align-items:center;gap:.4rem;padding:.5rem .9rem;background:#6d28d9;color:#fff;border:0;border-radius:.375rem;cursor:pointer";

export default function UiPage() {
  return h(
    "section",
    null,
    h("h1", null, "Radix dialog"),
    h(
      "p",
      null,
      "A real @radix-ui/react-dialog with lucide-react icons on denext's React.",
    ),
    h(
      Dialog.Root,
      null,
      h(
        Dialog.Trigger,
        { style: trigger },
        h(Info, { size: 16 }),
        "Open dialog",
      ),
      h(
        Dialog.Portal,
        null,
        h(Dialog.Overlay, { style: overlay }),
        h(
          Dialog.Content,
          { style: content },
          h(Dialog.Title, { style: "margin:0 0 .5rem" }, "Hello from Radix"),
          h(
            Dialog.Description,
            { style: "margin:0 0 1rem;color:#4b5563" },
            "This dialog is the real Radix primitive, bundled onto denext's single React.",
          ),
          h(
            Dialog.Close,
            {
              style:
                "display:inline-flex;align-items:center;gap:.3rem;padding:.35rem .7rem;border:1px solid #d1d5db;border-radius:.375rem;background:#fff;cursor:pointer",
            },
            h(X, { size: 14 }),
            "Close",
          ),
        ),
      ),
    ),
  );
}
