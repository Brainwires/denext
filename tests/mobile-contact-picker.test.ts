// `pickContact` (denext/mobile): the contacts plugin's picker in a faked Capacitor shell, the
// browser's Contact Picker API off it, and the `unsupported` rejection where neither exists; plus
// react-native-permissions' `openContactPicker` and expo-contacts' web picker over it.

import { assertEquals, assertRejects } from "@std/assert";
import {
  type ContactPickerError,
  contactPickerSupported,
  pickContact,
} from "../src/mobile/contact-picker.ts";
import { openContactPicker } from "../src/react-native-compat/permissions.ts";
import { presentContactPickerAsync } from "../src/expo/contacts.ts";
import { fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";

const ADA = {
  id: "c1",
  displayName: "Ada Lovelace",
  emailAddresses: [{ value: "ada@example.com" }, { value: "" }, {}],
  phoneNumbers: [{ value: "+44 1" }],
};

/** A browser Contact Picker that answers `chosen` and records what it was asked. */
function webPicker(
  chosen: Array<{ name?: string[]; email?: string[]; tel?: string[] }>,
  offered?: string[] | Error,
) {
  const asked: unknown[] = [];
  const contacts: Record<string, unknown> = {
    select: (properties: string[], options: unknown) => {
      asked.push([properties, options]);
      return Promise.resolve(chosen);
    },
  };
  if (offered) {
    contacts.getProperties = () =>
      offered instanceof Error ? Promise.reject(offered) : Promise.resolve(offered);
  }
  return { navigator: { contacts }, asked };
}

Deno.test("pickContact: the plugin's picker in the shell, its contact mapped", async () => {
  const picker = fakePlugin(["pickContact"], { pickContact: { contacts: [ADA] } });
  await inShell("ios", { CapacitorContacts: picker.plugin }, async () => {
    assertEquals(contactPickerSupported(), true);
    assertEquals(await pickContact(), {
      id: "c1",
      name: "Ada Lovelace",
      emails: ["ada@example.com"],
      phoneNumbers: ["+44 1"],
    });
  });
  assertEquals(picker.calls, [["pickContact", {}]]);
  // No display name: the full name, else the given and family names; no id, none reported.
  const parts = fakePlugin(["pickContact"], {
    pickContact: { contacts: [{ givenName: "Alan", familyName: "Turing", emailAddresses: null }] },
  });
  await inShell("android", { CapacitorContacts: parts.plugin }, async () => {
    assertEquals(await pickContact(), { name: "Alan Turing", emails: [], phoneNumbers: [] });
  });
  const full = fakePlugin(["pickContact"], {
    pickContact: { contacts: [{ id: "c3", displayName: null, fullName: "Grace Hopper" }] },
  });
  await inShell("android", { CapacitorContacts: full.plugin }, async () => {
    assertEquals((await pickContact())?.name, "Grace Hopper");
  });
});

Deno.test("pickContact: a cancel in the shell is null; another failure rejects", async () => {
  for (const result of [{ contacts: [] }, {}, new Error("User cancelled the picker")]) {
    const picker = fakePlugin(["pickContact"], { pickContact: result });
    await inShell("ios", { CapacitorContacts: picker.plugin }, async () => {
      assertEquals(await pickContact(), null);
    });
  }
  const failing = fakePlugin(["pickContact"], { pickContact: new Error("boom") });
  await inShell("ios", { CapacitorContacts: failing.plugin }, async () => {
    await assertRejects(() => pickContact(), Error, "boom");
  });
});

Deno.test("pickContact: the browser's Contact Picker off the shell, asked for what it offers", async () => {
  const web = webPicker(
    [{ name: ["Ada", "A. Lovelace"], email: ["ada@example.com"], tel: [] }],
    ["email", "name", "address"],
  );
  await withGlobals({ navigator: web.navigator }, async () => {
    assertEquals(contactPickerSupported(), true);
    assertEquals(await pickContact(), {
      name: "Ada",
      emails: ["ada@example.com"],
      phoneNumbers: [],
    });
  });
  assertEquals(web.asked, [[["name", "email"], { multiple: false }]]);
  // Without getProperties (or when it fails) all three are asked for; nothing chosen is null.
  for (const offered of [undefined, new Error("no")]) {
    const bare = webPicker([], offered);
    await withGlobals({ navigator: bare.navigator }, async () => {
      assertEquals(await pickContact(), null);
    });
    assertEquals(bare.asked, [[["name", "email", "tel"], { multiple: false }]]);
  }
  const nameless = webPicker([{ tel: ["+1 555"] }]);
  await withGlobals({ navigator: nameless.navigator }, async () => {
    assertEquals(await pickContact(), { name: "", emails: [], phoneNumbers: ["+1 555"] });
  });
});

Deno.test("pickContact: no plugin and no Contact Picker API rejects with code unsupported", async () => {
  await withGlobals({ navigator: {} }, async () => {
    assertEquals(contactPickerSupported(), false);
    const error = await assertRejects(() => pickContact(), Error, "no contact picker here");
    assertEquals((error as ContactPickerError).code, "unsupported");
    assertEquals(error.name, "ContactPickerError");
  });
  // A shell without the contacts plugin falls back the same way.
  await inShell("ios", {}, async () => {
    await assertRejects(() => pickContact(), Error, "denext mobile add contacts");
  }, { navigator: {} });
});

Deno.test("react-native-permissions: openContactPicker opens pickContact and resolves once it closes", async () => {
  const picker = fakePlugin(["pickContact"], { pickContact: { contacts: [ADA] } });
  await inShell("ios", { CapacitorContacts: picker.plugin }, async () => {
    assertEquals(await openContactPicker(), undefined);
  });
  assertEquals(picker.calls.length, 1);
  const cancelled = fakePlugin(["pickContact"], { pickContact: { contacts: [] } });
  await inShell("android", { CapacitorContacts: cancelled.plugin }, async () => {
    assertEquals(await openContactPicker(), undefined, "a cancel resolves");
  });
  const web = webPicker([]);
  await withGlobals({ navigator: web.navigator }, async () => {
    assertEquals(await openContactPicker(), undefined);
  });
  assertEquals(web.asked.length, 1, "the browser's picker opened");
  await withGlobals({ navigator: {} }, async () => {
    await assertRejects(
      () => openContactPicker(),
      Error,
      "react-native-permissions (denext): openContactPicker is not available here.",
    );
  });
  const failing = fakePlugin(["pickContact"], { pickContact: new Error("boom") });
  await inShell("ios", { CapacitorContacts: failing.plugin }, async () => {
    await assertRejects(() => openContactPicker(), Error, "boom");
  });
});

Deno.test("expo-contacts: presentContactPickerAsync uses the browser's Contact Picker off the shell", async () => {
  const web = webPicker([{ name: ["Ada"], email: ["ada@example.com"], tel: ["+44 1"] }]);
  await withGlobals({ navigator: web.navigator }, async () => {
    const contact = await presentContactPickerAsync();
    assertEquals(contact?.id, "");
    assertEquals(contact?.name, "Ada");
    assertEquals(contact?.emails?.map((e) => e.email), ["ada@example.com"]);
    assertEquals(contact?.phoneNumbers?.map((p) => p.number), ["+44 1"]);
  });
  await withGlobals({ navigator: webPicker([]).navigator }, async () => {
    assertEquals(await presentContactPickerAsync(), null, "nothing chosen");
  });
  await withGlobals({ navigator: {} }, async () => {
    await assertRejects(() => presentContactPickerAsync(), Error, "presentContactPickerAsync");
  });
});
