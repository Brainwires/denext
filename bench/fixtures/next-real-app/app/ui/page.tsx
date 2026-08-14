// UI — mirrors denext-app's Radix dialog + lucide page.
"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Info, X } from "lucide-react";

const overlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.4)",
} as const;
const content = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  background: "#fff",
  padding: "1.5rem",
  borderRadius: ".5rem",
  minWidth: "20rem",
  boxShadow: "0 10px 40px rgba(0,0,0,.2)",
} as const;
const trigger = {
  display: "inline-flex",
  alignItems: "center",
  gap: ".4rem",
  padding: ".5rem .9rem",
  background: "#6d28d9",
  color: "#fff",
  border: 0,
  borderRadius: ".375rem",
  cursor: "pointer",
} as const;

export default function UiPage() {
  return (
    <section>
      <h1>Radix dialog</h1>
      <p>
        A real @radix-ui/react-dialog with lucide-react icons on React + Next.
      </p>
      <Dialog.Root>
        <Dialog.Trigger style={trigger}>
          <Info size={16} />
          Open dialog
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay style={overlay} />
          <Dialog.Content style={content}>
            <Dialog.Title style={{ margin: "0 0 .5rem" }}>
              Hello from Radix
            </Dialog.Title>
            <Dialog.Description
              style={{ margin: "0 0 1rem", color: "#4b5563" }}
            >
              This dialog is the real Radix primitive on React + Next.
            </Dialog.Description>
            <Dialog.Close
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: ".3rem",
                padding: ".35rem .7rem",
                border: "1px solid #d1d5db",
                borderRadius: ".375rem",
                background: "#fff",
                cursor: "pointer",
              }}
            >
              <X size={14} />
              Close
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
