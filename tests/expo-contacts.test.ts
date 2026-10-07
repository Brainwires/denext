// expo-contacts over @capgo/capacitor-contacts (`CapacitorContacts`): the legacy function API
// and the class API in a faked Capacitor shell, and Expo's web answers off it.

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as Contacts from "../src/expo/contacts.ts";
import { type Any, fakePlugin, inShell } from "./helpers/mobile-fakes.ts";

const { Contact } = Contacts;

const METHODS = [
  "countContacts",
  "createContact",
  "deleteContactById",
  "displayContactById",
  "displayCreateContact",
  "displayUpdateContactById",
  "getContactById",
  "getContacts",
  "getGroups",
  "createGroup",
  "deleteGroupById",
  "pickContact",
  "updateContactById",
  "isAvailable",
  "checkPermissions",
  "requestPermissions",
];

/** A stored contact as the plugin returns it (birthday month 1–12). */
const ADA = {
  id: "c1",
  displayName: "Ada Lovelace",
  givenName: "Ada",
  familyName: "Lovelace",
  organizationName: "Analytical",
  note: "first programmer",
  birthday: { day: 10, month: 12, year: 1815 },
  emailAddresses: [{ value: "ada@example.com", type: "WORK", isPrimary: true }],
  phoneNumbers: [{ value: "+44 1", type: "WORK_MOBILE" }, { value: "+44 2", label: "Lab" }],
  postalAddresses: [{ street: "1 St", city: "London", state: "LDN", postalCode: "N1" }],
  urlAddresses: [{ value: "https://ada.example", type: "HOMEPAGE" }],
  photo: "iVBORw0KGgo",
  groupIds: ["g1"],
};
const ALAN = { id: "c2", displayName: "Alan Turing", givenName: "Alan", familyName: "Turing" };
const GRACE = { id: "c3", displayName: "Grace Hopper", givenName: "Grace", familyName: "Hopper" };

/** A plugin fake whose methods answer the given results. */
function contactsPlugin(results: Record<string, unknown> = {}) {
  return fakePlugin(METHODS, {
    checkPermissions: { readContacts: "granted", writeContacts: "granted" },
    getContacts: { contacts: [ADA, ALAN, GRACE] },
    getContactById: { contact: ADA },
    countContacts: { count: 3 },
    ...results,
  });
}

/** Run `fn` in an iOS shell with `fake` as `CapacitorContacts`. */
function withPlugin(fake: { plugin: unknown }, fn: () => Promise<void>): Promise<void> {
  return inShell("ios", { CapacitorContacts: fake.plugin }, fn);
}

const calls = (fake: { calls: Array<[string, unknown]> }, name: string) =>
  fake.calls.filter(([m]) => m === name).map(([, arg]) => arg as Any);

// ---- off the shell -------------------------------------------------------------------------

Deno.test("expo-contacts: off the shell calls reject ERR_UNAVAILABLE; permissions are undetermined", async () => {
  for (
    const call of [
      () => Contacts.getContactsAsync(),
      () => Contacts.getContactByIdAsync("x"),
      () => Contacts.addContactAsync({ contactType: "person", name: "x" }),
      () => Contacts.updateContactAsync({ id: "x" }),
      () => Contacts.removeContactAsync("x"),
      () => Contacts.presentFormAsync(),
      () => Contacts.presentContactPickerAsync(),
      () => Contacts.hasContactsAsync(),
      () => Contacts.getGroupsAsync({}),
      () => Contacts.getDefaultContainerIdAsync(),
      () => Contacts.Contact.getAll(),
      () => new Contact("x").getDetails(),
      () => Contacts.Group.getAll(),
    ]
  ) {
    const err = await assertRejects(call) as Any;
    assertEquals(err.code, "ERR_UNAVAILABLE");
    assert(String(err.message).includes("denext mobile add contacts"), err.message);
  }
  const answer = await Contacts.getPermissionsAsync();
  assertEquals(answer as Any, {
    status: "undetermined",
    expires: "never",
    granted: false,
    canAskAgain: true,
  });
  assertEquals((await Contacts.requestPermissionsAsync()).status, "undetermined");
  assertEquals(await Contacts.isAvailableAsync(), false);
  const sub = Contacts.addContactsChangeListener(() => {});
  sub.remove();
  Contacts.removeAllContactsChangeListeners();
  assertEquals(Contacts.ContactAccessButton.isAvailable(), false);
  assertEquals(Contacts.ContactAccessButton({ query: "a" }), null);
});

// ---- the legacy API ------------------------------------------------------------------------

Deno.test("expo-contacts: getContactsAsync maps contacts to Expo's legacy shape", async () => {
  const fake = contactsPlugin();
  await withPlugin(fake, async () => {
    const { data, hasNextPage, hasPreviousPage } = await Contacts.getContactsAsync();
    assertEquals([hasNextPage, hasPreviousPage], [false, false]);
    assertEquals(calls(fake, "getContacts"), [{}]);
    assertEquals(data.map((c) => c.name), ["Ada Lovelace", "Alan Turing", "Grace Hopper"]);
    const ada = data[0];
    assertEquals(ada.id, "c1");
    assertEquals(ada.contactType, "person");
    assertEquals([ada.firstName, ada.lastName, ada.company, ada.note], [
      "Ada",
      "Lovelace",
      "Analytical",
      "first programmer",
    ]);
    assertEquals(ada.birthday, { day: 10, month: 11, year: 1815, format: "gregorian" });
    assertEquals(ada.emails, [{
      id: "0",
      email: "ada@example.com",
      label: "work",
      isPrimary: true,
    }]);
    assertEquals(ada.phoneNumbers, [
      { id: "0", number: "+44 1", label: "work mobile" },
      { id: "1", number: "+44 2", label: "Lab" },
    ]);
    assertEquals(ada.addresses, [{
      id: "0",
      label: "other",
      street: "1 St",
      city: "London",
      region: "LDN",
      postalCode: "N1",
    }]);
    assertEquals(ada.urlAddresses, [{ id: "0", url: "https://ada.example", label: "homepage" }]);
    assertEquals(ada.imageAvailable, true);
    assertEquals(ada.image?.uri, "data:image/png;base64,iVBORw0KGgo");
    assertEquals(data[1].imageAvailable, undefined);
  });
});

Deno.test("expo-contacts: paging and fields go to the plugin; filters and sorts page here", async () => {
  const fake = contactsPlugin({ getContacts: { contacts: [ADA, ALAN] } });
  await withPlugin(fake, async () => {
    // Plugin paging: one extra row tells whether a next page exists.
    const page = await Contacts.getContactsAsync({
      pageSize: 1,
      pageOffset: 2,
      fields: [Contacts.Fields.Emails, Contacts.Fields.FirstName, Contacts.Fields.Nickname],
    });
    assertEquals(calls(fake, "getContacts")[0], {
      fields: ["displayName", "fullName", "givenName", "familyName", "emailAddresses"],
      limit: 2,
      offset: 2,
    });
    assertEquals(page.data.map((c) => c.id), ["c1"]);
    assertEquals([page.hasNextPage, page.hasPreviousPage], [true, true]);
  });

  const all = contactsPlugin();
  await withPlugin(all, async () => {
    // A name filter reads the whole list, then filters and pages here.
    const named = await Contacts.getContactsAsync({ name: "al", pageSize: 1 });
    assertEquals(calls(all, "getContacts")[0], {});
    assertEquals(named.data.map((c) => c.id), ["c2"]);
    assertEquals(named.hasNextPage, false);
    // Sorted by family name, second page of one.
    const sorted = await Contacts.getContactsAsync({
      sort: Contacts.SortTypes.LastName,
      pageSize: 1,
      pageOffset: 1,
    });
    assertEquals(sorted.data.map((c) => c.lastName), ["Lovelace"]);
    assertEquals([sorted.hasNextPage, sorted.hasPreviousPage], [true, true]);
    // A group filter keeps the members.
    const group = await Contacts.getContactsAsync({ groupId: "g1" });
    assertEquals(group.data.map((c) => c.id), ["c1"]);
    // Ids are read one by one.
    const byId = await Contacts.getPagedContactsAsync({ id: ["c1"] });
    assertEquals(calls(all, "getContactById"), [{ id: "c1" }]);
    assertEquals(byId.data.map((c) => c.id), ["c1"]);
  });
});

Deno.test("expo-contacts: getContactByIdAsync maps fields and a missing contact", async () => {
  const fake = contactsPlugin();
  await withPlugin(fake, async () => {
    const ada = await Contacts.getContactByIdAsync("c1", [Contacts.Fields.PhoneNumbers]);
    assertEquals(calls(fake, "getContactById")[0], {
      id: "c1",
      fields: ["displayName", "fullName", "givenName", "familyName", "phoneNumbers"],
    });
    assertEquals(ada?.name, "Ada Lovelace");
  });
  await withPlugin(contactsPlugin({ getContactById: { contact: null } }), async () => {
    assertEquals(await Contacts.getContactByIdAsync("nope"), undefined);
  });
});

Deno.test("expo-contacts: add, update (read-modify-write) and remove", async () => {
  const fake = contactsPlugin({ createContact: { id: "new" } });
  await withPlugin(fake, async () => {
    const id = await Contacts.addContactAsync({
      contactType: Contacts.ContactTypes.Person,
      name: "Bob Smith",
      firstName: "Bob",
      lastName: "Smith",
      company: "Acme",
      birthday: { day: 1, month: 0, year: 2000 },
      emails: [{ email: "bob@acme.test", label: "work" }],
      phoneNumbers: [{ number: "555", label: "mobile" }, { number: "556", label: "Boat" }],
      addresses: [{ street: "2 Rd", region: "CA", postalCode: "9", label: "home" }],
      urlAddresses: [{ url: "https://bob.test", label: "blog" }],
    }, "ignored-container");
    assertEquals(id, "new");
    assertEquals(calls(fake, "createContact")[0], {
      contact: {
        givenName: "Bob",
        familyName: "Smith",
        organizationName: "Acme",
        birthday: { day: 1, month: 1, year: 2000 },
        emailAddresses: [{ value: "bob@acme.test", type: "WORK" }],
        phoneNumbers: [{ value: "555", type: "MOBILE" }, {
          value: "556",
          type: "CUSTOM",
          label: "Boat",
        }],
        postalAddresses: [{ street: "2 Rd", state: "CA", postalCode: "9", type: "HOME" }],
        urlAddresses: [{ value: "https://bob.test", type: "BLOG" }],
      },
    });

    assertEquals(await Contacts.updateContactAsync({ id: "c1", jobTitle: "Countess" }), "c1");
    assertEquals(calls(fake, "getContactById")[0], { id: "c1" });
    const written = calls(fake, "updateContactById")[0];
    assertEquals(written.id, "c1");
    assertEquals(written.contact.jobTitle, "Countess");
    assertEquals(written.contact.givenName, "Ada", "the stored fields are kept");
    assertEquals(written.contact.emailAddresses, ADA.emailAddresses);
    assertEquals(
      ["id", "displayName"].filter((k) => k in written.contact),
      [],
      "read-only keys are not written back",
    );

    await Contacts.removeContactAsync("c1");
    assertEquals(calls(fake, "deleteContactById"), [{ id: "c1" }]);
  });
});

Deno.test("expo-contacts: forms, the picker, availability and groups", async () => {
  const fake = contactsPlugin({
    pickContact: { contacts: [ALAN] },
    isAvailable: { isAvailable: true },
    getGroups: { groups: [{ id: "g1", name: "Family" }, { id: "g2", name: "Work" }] },
    createGroup: { id: "g3" },
    displayCreateContact: { id: "made" },
  });
  await withPlugin(fake, async () => {
    await Contacts.presentFormAsync("c1");
    await Contacts.presentFormAsync("c1", null, { allowsEditing: false });
    await Contacts.presentFormAsync(null, { contactType: "person", name: "", firstName: "Z" });
    assertEquals(calls(fake, "displayUpdateContactById"), [{ id: "c1" }]);
    assertEquals(calls(fake, "displayContactById"), [{ id: "c1" }]);
    assertEquals(calls(fake, "displayCreateContact"), [{ contact: { givenName: "Z" } }]);

    assertEquals((await Contacts.presentContactPickerAsync())?.name, "Alan Turing");
    assertEquals(await Contacts.isAvailableAsync(), true);
    assertEquals(await Contacts.hasContactsAsync(), true);

    assertEquals(await Contacts.getGroupsAsync({}), [{ id: "g1", name: "Family" }, {
      id: "g2",
      name: "Work",
    }]);
    assertEquals(await Contacts.getGroupsAsync({ groupName: "Work" }), [{
      id: "g2",
      name: "Work",
    }]);
    assertEquals(await Contacts.createGroupAsync("Friends"), "g3");
    assertEquals(calls(fake, "createGroup"), [{ group: { name: "Friends" } }]);
    await Contacts.removeGroupAsync("g2");
    assertEquals(calls(fake, "deleteGroupById"), [{ id: "g2" }]);

    const err = await assertRejects(() => Contacts.getContainersAsync({})) as Any;
    assertEquals(err.code, "ERR_UNAVAILABLE");
  });
  await withPlugin(contactsPlugin({ pickContact: { contacts: [] } }), async () => {
    assertEquals(await Contacts.presentContactPickerAsync(), null, "a cancelled picker");
  });
});

Deno.test("expo-contacts: permissions map read + write states", async () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["granted", "granted", { status: "granted", canAskAgain: true, accessPrivileges: "all" }],
    ["limited", "limited", { status: "granted", granted: true, accessPrivileges: "limited" }],
    ["denied", "denied", { status: "denied", canAskAgain: false, accessPrivileges: "none" }],
    ["prompt-with-rationale", "granted", { status: "denied", canAskAgain: true }],
    ["prompt", "prompt", { status: "undetermined", canAskAgain: true, accessPrivileges: "none" }],
  ];
  for (const [read, write, expected] of cases) {
    const state = { readContacts: read, writeContacts: write };
    const fake = contactsPlugin({ checkPermissions: state, requestPermissions: state });
    await withPlugin(fake, async () => {
      const got = await Contacts.getPermissionsAsync() as Any;
      for (const [key, value] of Object.entries(expected)) assertEquals(got[key], value, key);
      assertEquals((await Contacts.requestPermissionsAsync()).status, expected.status);
      assertEquals(calls(fake, "requestPermissions").length, 1);
    });
  }
});

// ---- the class API -------------------------------------------------------------------------

Deno.test("expo-contacts: Contact statics", async () => {
  const fake = contactsPlugin({
    createContact: { id: "c9" },
    pickContact: { contacts: [GRACE] },
    displayCreateContact: {},
  });
  await withPlugin(fake, async () => {
    const all = await Contact.getAll({
      sortOrder: Contacts.ContactsSortOrder.GivenName,
      limit: 2,
    });
    assertEquals(all.map((c) => c.id), ["c1", "c2"]);
    assert(all[0] instanceof Contact);

    const details = await Contact.getAllDetails([Contacts.ContactField.PHONES], { name: "grace" });
    assertEquals(details, [{ id: "c3", phones: [] }]);

    const made = await Contact.create({
      givenName: "Kat",
      prefix: "Dr",
      birthday: { day: 2, month: 3 },
      emails: [{ address: "k@x.test", label: "home" }],
      addresses: [{ street: "S", postcode: "P", region: "R" }],
    });
    assertEquals(made.id, "c9");
    assertEquals(calls(fake, "createContact")[0], {
      contact: {
        givenName: "Kat",
        namePrefix: "Dr",
        birthday: { day: 2, month: 3 },
        emailAddresses: [{ value: "k@x.test", type: "HOME" }],
        postalAddresses: [{ street: "S", state: "R", postalCode: "P" }],
      },
    });
    assertEquals(await Contact.presentCreateForm({ givenName: "Q" }), false, "cancelled form");
    assertEquals(await Contact.getCount(), 3);
    assertEquals(await Contact.hasAny(), true);
    assertEquals((await Contact.presentPicker())?.id, "c3");
  });
});

Deno.test("expo-contacts: Contact instance reads, patch and setters", async () => {
  const fake = contactsPlugin();
  await withPlugin(fake, async () => {
    const ada = new Contact("c1");
    const details = await ada.getDetails([
      Contacts.ContactField.GIVEN_NAME,
      Contacts.ContactField.BIRTHDAY,
      Contacts.ContactField.EMAILS,
      Contacts.ContactField.IS_FAVOURITE,
    ]);
    assertEquals(calls(fake, "getContactById")[0], {
      id: "c1",
      fields: ["displayName", "givenName", "birthday", "emailAddresses"],
    });
    assertEquals(details, {
      id: "c1",
      givenName: "Ada",
      birthday: { day: 10, month: 12, year: 1815 },
      emails: [{ id: "0", address: "ada@example.com", label: "work" }],
      isFavourite: false,
    });
    const every = await ada.getDetails();
    assertEquals(every.fullName, "Ada Lovelace");
    assertEquals(every.image, "data:image/png;base64,iVBORw0KGgo");
    assertEquals(every.socialProfiles, []);

    assertEquals(await ada.getFullName(), "Ada Lovelace");
    assertEquals(await ada.getGivenName(), "Ada");
    assertEquals(await ada.getCompany(), "Analytical");
    assertEquals(await ada.getJobTitle(), null);
    assertEquals((await ada.getPhones()).map((p) => p.label), ["work mobile", "Lab"]);
    assertEquals(await ada.getBirthday(), { day: 10, month: 12, year: 1815 });

    await ada.patch({ familyName: "King", note: null, birthday: null });
    let written = calls(fake, "updateContactById").at(-1);
    assertEquals(written.contact.familyName, "King");
    assertEquals(written.contact.note, "", "null clears a text field");
    assertEquals("birthday" in written.contact, false, "null drops the birthday");
    assertEquals(written.contact.givenName, "Ada");

    assertEquals(await ada.setJobTitle("Countess"), true);
    written = calls(fake, "updateContactById").at(-1);
    assertEquals([written.contact.jobTitle, written.contact.organizationName], [
      "Countess",
      "Analytical",
    ]);

    await ada.delete();
    assertEquals(calls(fake, "deleteContactById"), [{ id: "c1" }]);
  });
});

Deno.test("expo-contacts: Group over the plugin's groups", async () => {
  const fake = contactsPlugin({
    getGroups: { groups: [{ id: "g1", name: "Family" }] },
    createGroup: { id: "g2" },
  });
  await withPlugin(fake, async () => {
    const groups = await Contacts.Group.getAll();
    assertEquals(groups.map((g) => g.id), ["g1"]);
    assertEquals(await groups[0].getName(), "Family");
    assertEquals(await new Contacts.Group("gone").getName(), null);
    assertEquals((await groups[0].getContacts()).map((c) => c.id), ["c1"]);
    assertEquals((await Contacts.Group.create("New")).id, "g2");
    await groups[0].delete();
    assertEquals(calls(fake, "deleteGroupById"), [{ id: "g1" }]);
  });
});

Deno.test("expo-contacts: enums carry Expo's values", () => {
  assertEquals(Contacts.Fields.PhoneNumbers, "phoneNumbers");
  assertEquals(Contacts.Fields.IsFavorite, "isFavorite");
  assertEquals(Contacts.SortTypes.UserDefault, "userDefault");
  assertEquals(Contacts.ContainerTypes.CardDAV, "cardDAV");
  assertEquals(Contacts.CalendarFormats.IslamicUmmAlQura, "islamicUmmAlQura");
  assertEquals(Contacts.ContactField.IM_ADDRESSES, "imAddresses");
  assertEquals(Contacts.ContactsSortOrder.FamilyName, "familyName");
  assertEquals(Contacts.NonGregorianCalendar.republicOfChina, "republicOfChina");
  assertEquals(Contacts.PermissionStatus.UNDETERMINED, "undetermined");
});
