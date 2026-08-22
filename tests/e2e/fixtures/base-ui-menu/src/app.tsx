// A REAL @base-ui/react Menu on denext's own React. Clicking the trigger must OPEN
// the menu and keep it open — the classic failure is the dismiss/outside-press layer
// catching the very click that opened it and closing it on the same tick.
import { Menu } from "@base-ui/react/menu";

export function App() {
  return (
    <main style={{ padding: 40 }}>
      <Menu.Root>
        <Menu.Trigger data-testid="trigger">All projects ▾</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner data-testid="positioner">
            <Menu.Popup data-testid="popup">
              <Menu.Item data-testid="item-a">Alpha</Menu.Item>
              <Menu.Item data-testid="item-b">Bravo</Menu.Item>
              <Menu.Item data-testid="item-c">Charlie</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </main>
  );
}
