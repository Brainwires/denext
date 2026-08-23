// A REAL @base-ui/react Dialog on denext's own React, structured like a command
// palette (Portal > Backdrop + Viewport > Popup, with an inline Autocomplete inside).
// Base UI removes `data-starting-style` one animation-frame after open (a setState
// scheduled in requestAnimationFrame), letting the popup/backdrop transition from
// opacity:0 to opacity:1. This exercises the store-subscription + rAF + transition
// path across a portal; the popup must end up visible (opacity 1, no start-frame).
import { useReducer } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Autocomplete } from "@base-ui/react/autocomplete";

const CSS = `
  [data-testid="backdrop"] { position: fixed; inset: 0; background: rgba(0,0,0,.5);
    opacity: 1; transition: opacity 150ms ease; }
  [data-testid="backdrop"][data-starting-style] { opacity: 0; }
  [data-testid="popup"] { position: fixed; top: 40%; left: 40%; width: 300px;
    background: #fff; padding: 20px; opacity: 1; transition: opacity 150ms ease; }
  [data-testid="popup"][data-starting-style] { opacity: 0; }
`;

export function App() {
  const [open, setOpen] = useReducer((_: boolean, v: boolean) => v, false);
  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {
        /* An explicit close control so the test drives a real close (open=false) —
          Base UI's Escape/backdrop dismiss doesn't fire reliably headless. */
      }
      <button type="button" data-testid="closebtn" onClick={() => setOpen(false)}>close</button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger data-testid="trigger">Add project</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop data-testid="backdrop" />
          <Dialog.Viewport data-testid="viewport">
            <Dialog.Popup data-testid="popup">
              <Dialog.Title>Add project</Dialog.Title>
              <Autocomplete.Root
                items={["Alpha", "Bravo", "Charlie", "Delta", "Echo"]}
                open
                inline
                autoHighlight="always"
                keepHighlight
              >
                <Autocomplete.Input data-testid="field" placeholder="project name" />
                <Autocomplete.List data-testid="cmdlist">
                  {(item: string) => (
                    <Autocomplete.Item key={item} value={item}>
                      {item}
                    </Autocomplete.Item>
                  )}
                </Autocomplete.List>
              </Autocomplete.Root>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
