// A Flight page: a Server Component rendering a client island that calls a Server Action and
// joins a Live presence room, and one handed a Server Action as a prop (the Flight client's own
// action reference).

import { bump } from "./actions.ts";
import { LiveBox } from "./live-box.tsx";
import { SaveButton } from "./save-button.tsx";

export default function FlightPage() {
  return (
    <>
      <LiveBox />
      <SaveButton save={bump} />
    </>
  );
}
