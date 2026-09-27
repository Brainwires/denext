// Dialogs. denext/mobile does not export a dialog API: `showDialog` (src/mobile/dialog.ts) is
// internal and public only as React Native mode's Alert.alert / Alert.prompt. This example
// imports it by relative path, to test the capability.
import { showDialog } from "../../../../src/mobile/dialog.ts";
import { Button, Output, useRun } from "../ui.tsx";
import { Screen } from "./shell.tsx";

const twoButton = () =>
  showDialog({
    title: "Delete draft?",
    message: "Two buttons: this is the NATIVE iOS alert.",
    buttons: [{ text: "Cancel", style: "cancel" }, {
      text: "Delete",
      style: "destructive",
    }],
  });

export const threeButton = () =>
  showDialog({
    title: "Save changes?",
    message: "Three buttons: this is the IN-PAGE dialog (Delete is red).",
    buttons: [
      { text: "Cancel", style: "cancel" },
      { text: "Don't save", style: "destructive" },
      { text: "Save", preferred: true },
    ],
  });

export function DialogsScreen() {
  const [out, run] = useRun();
  return (
    <Screen
      title="Dialogs"
      todo="'2 buttons' shows the native iOS alert (system look, dims the whole screen): press either button and the result shows index 0 or 1. '3 buttons' shows the in-page dialog with a red 'Don't save': the result shows the index pressed. 'Prompt' shows the native text prompt: type something and press OK; the result shows your text."
    >
      <div class="row btn-row">
        <Button label="2 buttons (native)" onClick={() => run(twoButton)} />
        <Button label="3 buttons (in-page)" onClick={() => run(threeButton)} />
        <Button
          label="Prompt"
          onClick={() =>
            run(() =>
              showDialog({
                title: "Your name",
                message: "A plain-text prompt (native).",
                input: "plain-text",
                defaultValue: "Ada",
                buttons: [{ text: "Cancel", style: "cancel" }, { text: "OK" }],
              })
            )}
        />
      </div>
      <Output value={out} />
    </Screen>
  );
}
