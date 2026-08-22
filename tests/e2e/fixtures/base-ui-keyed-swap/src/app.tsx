// Mirrors T3's CommandPalette: a Base UI Dialog whose inner content is KEYED, with the
// key changing when `browsing` flips (T3: key={`...-${isBrowsing}-...`}). Inside, a
// start-addon that swaps <button>Back</button> -> <FolderIcon/> at the same unkeyed
// slot, plus an absolutely-positioned "Add" accessory that only appears while browsing.
// If denext leaves the pre-flip subtree mounted, the DOM ends up with a stale Back
// button stacked on the new content -> two live buttons. This asserts exactly one of each.
import { useReducer } from "react";
import { Dialog } from "@base-ui/react/dialog";

const CSS = `
  [data-testid="popup"]{position:fixed;top:40%;left:40%;width:320px;background:#fff;padding:16px}
  .row{position:relative;height:36px;border:1px solid #ccc;border-radius:6px}
  [data-slot="start-addon"]{position:absolute;inset-inline-start:6px;top:0;bottom:0;display:flex;align-items:center}
  [data-slot="accessory"]{position:absolute;inset-inline-end:6px;top:50%;transform:translateY(-50%)}
`;

function FolderIcon() {
  return <span data-testid="folder">[folder]</span>;
}

// The keyed content — a fresh key remounts this whole subtree (T3 CommandPaletteContent).
function Content({ browsing }: { browsing: boolean }) {
  return (
    <div className="row" data-testid="row">
      <span data-slot="start-addon">
        {browsing ? <FolderIcon /> : (
          <button type="button" data-testid="back" aria-label="Back">
            &lt;-
          </button>
        )}
      </span>
      <input data-testid="field" placeholder="project name" />
      {browsing
        ? (
          <button type="button" data-slot="accessory" data-testid="add">
            Add
          </button>
        )
        : null}
    </div>
  );
}

export function App() {
  const [open, setOpen] = useReducer((_: boolean, v: boolean) => v, true);
  const [browsing, setBrowsing] = useReducer((_: boolean, v: boolean) => v, false);
  const contentKey = `${browsing}`; // key changes on flip, like T3's palette
  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <button type="button" data-testid="localfolder" onClick={() => setBrowsing(true)}>
        Local folder
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop data-testid="backdrop" />
          <Dialog.Viewport>
            <Dialog.Popup data-testid="popup">
              <Dialog.Title>Add project</Dialog.Title>
              <Content key={contentKey} browsing={browsing} />
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
