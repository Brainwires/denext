// The Expo calls the pinned Capacitor plugins have no call for, through denext's own plugins
// beside them (`denext mobile add calendar | contacts | print | brightness`): DenextCalendar
// (attendees, an event by id, one occurrence's changes, time zones, the event viewer),
// DenextContacts (containers, change events, Android's full updates), DenextPrint (HTML to PDF,
// the iOS printer picker) and DenextBrightness (Android's system brightness, iOS's change
// events). Each runs in a faked shell with the pinned plugin and denext's beside it.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as Brightness from "../src/expo/brightness.ts";
import * as Calendar from "../src/expo/calendar.ts";
import * as Contacts from "../src/expo/contacts.ts";
import * as Print from "../src/expo/print.ts";
import { type Any, fakePlugin, inShell, settle } from "./helpers/mobile-fakes.ts";

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const HOUR = 3_600_000;

/** The arguments of every call to `method`. */
function callsTo(fake: ReturnType<typeof fakePlugin>, method: string): unknown[] {
  return fake.calls.filter(([m]) => m === method).map(([, arg]) => arg);
}

// ---- expo-brightness ------------------------------------------------------------------------

const SCREEN_BRIGHTNESS = ["setBrightness", "getBrightness"];
const DENEXT_BRIGHTNESS = [
  "getSystemBrightness",
  "setSystemBrightness",
  "getSystemBrightnessMode",
  "setSystemBrightnessMode",
  "checkWriteSettings",
  "requestWriteSettings",
];

Deno.test("expo-brightness (Android): the system setting and its mode through DenextBrightness", async () => {
  const screen = fakePlugin(SCREEN_BRIGHTNESS, { getBrightness: { brightness: -1 } });
  const denext = fakePlugin(DENEXT_BRIGHTNESS, {
    getSystemBrightness: { value: 0.25 },
    getSystemBrightnessMode: { mode: "automatic" },
    checkWriteSettings: { granted: false },
    requestWriteSettings: { granted: true },
  });
  await inShell(
    "android",
    { ScreenBrightness: screen.plugin, DenextBrightness: denext.plugin },
    async () => {
      // The window follows the system: the level read is the system's, as in Expo.
      assertEquals(await Brightness.getBrightnessAsync(), 0.25);
      assertEquals(await Brightness.getSystemBrightnessAsync(), 0.25);
      await Brightness.setSystemBrightnessAsync(1.4); // clamped, as Expo
      assertEquals(callsTo(denext, "setSystemBrightness"), [{ value: 1 }]);
      assertEquals(
        await Brightness.getSystemBrightnessModeAsync(),
        Brightness.BrightnessMode.AUTOMATIC,
      );
      await Brightness.setSystemBrightnessModeAsync(Brightness.BrightnessMode.MANUAL);
      await Brightness.setSystemBrightnessModeAsync(Brightness.BrightnessMode.UNKNOWN); // no-op
      assertEquals(callsTo(denext, "setSystemBrightnessMode"), [{ mode: "manual" }]);
      // WRITE_SETTINGS: denied (askable again) until the user allows it in the settings screen.
      const before = await Brightness.getPermissionsAsync();
      assertEquals([before.status, before.granted, before.canAskAgain], ["denied", false, true]);
      const after = await Brightness.requestPermissionsAsync();
      assertEquals([after.status, after.granted], ["granted", true]);
      assertEquals(callsTo(denext, "requestWriteSettings").length, 1);
    },
  );
  // A level the window has: the window's, the system is not read.
  const set = fakePlugin(SCREEN_BRIGHTNESS, { getBrightness: { brightness: 0.6 } });
  const quiet = fakePlugin(DENEXT_BRIGHTNESS, { getSystemBrightness: { value: 0.1 } });
  await inShell(
    "android",
    { ScreenBrightness: set.plugin, DenextBrightness: quiet.plugin },
    async () => {
      assertEquals(await Brightness.getBrightnessAsync(), 0.6);
      assertEquals(callsTo(quiet, "getSystemBrightness"), []);
    },
  );
});

Deno.test("expo-brightness (iOS): the listener fires on DenextBrightness's change events", async () => {
  const screen = fakePlugin(SCREEN_BRIGHTNESS, { getBrightness: { brightness: 0.5 } });
  const denext = fakePlugin(["getSystemBrightness"], { getSystemBrightness: { value: 0.5 } });
  await inShell(
    "ios",
    { ScreenBrightness: screen.plugin, DenextBrightness: denext.plugin },
    async () => {
      const seen: number[] = [];
      const sub = Brightness.addBrightnessListener(({ brightness }) => seen.push(brightness));
      await settle();
      assertEquals(denext.listening(), 1);
      denext.fire("brightnessChanged", { brightness: 0.8 });
      assertEquals(seen, [0.8]);
      sub.remove();
      await settle();
      assertEquals(denext.listening(), 0, "the native listener goes with the last one");
      // iOS needs no permission for any of it, as in Expo.
      assertEquals((await Brightness.requestPermissionsAsync()).granted, true);
    },
  );
});

// ---- expo-print -----------------------------------------------------------------------------

Deno.test("expo-print: printToFileAsync through DenextPrint, on iOS and Android", async () => {
  const pdf = { uri: "file:///cache/Print/a.pdf", numberOfPages: 2, base64: "JVBERi0=" };
  for (const platform of ["ios", "android"] as const) {
    const denext = fakePlugin(["printToFile", "selectPrinter", "printToPrinter"], {
      printToFile: pdf,
    });
    await inShell(platform, { DenextPrint: denext.plugin }, async () => {
      assertEquals(
        await Print.printToFileAsync({
          html: "<h1>Receipt</h1>",
          width: 300,
          height: 400,
          margins: { top: 10, right: 10, bottom: 10, left: 10 },
          base64: true,
        }),
        pdf,
      );
      assertEquals((await Print.printToFileAsync()).uri, pdf.uri);
      assertEquals(callsTo(denext, "printToFile"), [
        {
          html: "<h1>Receipt</h1>",
          width: 300,
          height: 400,
          margins: { top: 10, right: 10, bottom: 10, left: 10 },
          base64: true,
        },
        { html: "" },
      ]);
    });
  }
});

Deno.test("expo-print (iOS): the printer picker, and printerUrl prints without the dialog", async () => {
  const printer = fakePlugin(["printHtml", "printBase64", "printFile"]);
  const denext = fakePlugin(["printToFile", "selectPrinter", "printToPrinter"], {
    selectPrinter: { name: "Office", url: "ipps://office.local/ipp/print" },
  });
  await inShell("ios", { Printer: printer.plugin, DenextPrint: denext.plugin }, async () => {
    const picked = await Print.selectPrinterAsync();
    assertEquals(picked, { name: "Office", url: "ipps://office.local/ipp/print" });
    await Print.printAsync({ html: "<p>x</p>", printerUrl: picked.url });
    await Print.printAsync({ uri: "data:application/pdf;base64,JVBERi0=", printerUrl: picked.url });
    await Print.printAsync({ uri: "file:///var/mobile/a.pdf", printerUrl: picked.url });
    assertEquals(callsTo(denext, "printToPrinter"), [
      { printerUrl: picked.url, html: "<p>x</p>" },
      { printerUrl: picked.url, data: "JVBERi0=" },
      { printerUrl: picked.url, path: "/var/mobile/a.pdf" },
    ]);
    // Without printerUrl the system dialog prints, as before.
    await Print.printAsync({ html: "<p>y</p>" });
    assertEquals(printer.calls, [["printHtml", { html: "<p>y</p>" }]]);
  });
  // Android: no printer picker, as in Expo; printerUrl is left to the dialog.
  await inShell("android", { Printer: printer.plugin, DenextPrint: denext.plugin }, async () => {
    const err = await assertRejects(() => Print.selectPrinterAsync());
    assertEquals((err as Any).code, "ERR_UNAVAILABLE");
    await Print.printAsync({ html: "<p>z</p>", printerUrl: "ipps://x" });
    assertEquals(printer.calls.at(-1), ["printHtml", { html: "<p>z</p>" }]);
  });
  // A shell without DenextPrint: both unavailable.
  await inShell("ios", { Printer: printer.plugin }, async () => {
    for (const call of [() => Print.selectPrinterAsync(), () => Print.printToFileAsync()]) {
      const err = await assertRejects(call);
      assertEquals((err as Any).code, "ERR_UNAVAILABLE");
    }
  });
});

// ---- expo-contacts --------------------------------------------------------------------------

const CAPGO_CONTACTS = [
  "countContacts",
  "createContact",
  "deleteContactById",
  "getContactById",
  "getContacts",
  "getGroups",
  "updateContactById",
  "checkPermissions",
  "requestPermissions",
];
const DENEXT_CONTACTS = [
  "getContainers",
  "getDefaultContainerId",
  "getContainerGroups",
  "getContainerContactIds",
  "writeExtras",
  "watchChanges",
];

const ADA = {
  id: "c1",
  givenName: "Ada",
  familyName: "Lovelace",
  jobTitle: "Programmer",
  birthday: { day: 10, month: 12, year: 1815 },
  postalAddresses: [{ street: "1 St", city: "London", type: "HOME" }],
  urlAddresses: [{ value: "https://ada.example", type: "HOME" }],
  photo: "iVBORw0KGgo",
};

Deno.test("expo-contacts (Android): an update writes the addresses, URLs, birthday and photo back", async () => {
  const capgo = fakePlugin(CAPGO_CONTACTS, { getContactById: { contact: ADA } });
  const denext = fakePlugin(DENEXT_CONTACTS);
  await inShell(
    "android",
    { CapacitorContacts: capgo.plugin, DenextContacts: denext.plugin },
    async () => {
      assertEquals(await Contacts.updateContactAsync({ id: "c1", jobTitle: "Countess" }), "c1");
      assertEquals(callsTo(capgo, "updateContactById").length, 1);
      assertEquals(callsTo(denext, "writeExtras"), [{
        id: "c1",
        postalAddresses: ADA.postalAddresses,
        urlAddresses: ADA.urlAddresses,
        birthday: ADA.birthday,
        photo: ADA.photo,
      }]);
      // The class API's setters go through the same write.
      await new Contacts.Contact("c1").setBirthday(null);
      assertEquals((callsTo(denext, "writeExtras")[1] as Any).birthday, null);
      // Containers are iOS only, as in Expo.
      const err = await assertRejects(() => Contacts.getDefaultContainerIdAsync());
      assertEquals((err as Any).code, "ERR_UNAVAILABLE");
      await assertRejects(() => Contacts.Container.getAll(), Error, "iOS only");
    },
  );
  // iOS: the plugin keeps every field, so nothing more is written.
  const ios = fakePlugin(DENEXT_CONTACTS);
  await inShell(
    "ios",
    { CapacitorContacts: capgo.plugin, DenextContacts: ios.plugin },
    async () => {
      await Contacts.updateContactAsync({ id: "c1", jobTitle: "Countess" });
      assertEquals(callsTo(ios, "writeExtras"), []);
    },
  );
});

Deno.test("expo-contacts (iOS): containers through DenextContacts, legacy and class API", async () => {
  const capgo = fakePlugin(CAPGO_CONTACTS);
  const local = { id: "K1", name: "iCloud", type: "cardDAV" };
  const denext = fakePlugin(DENEXT_CONTACTS, {
    getContainers: { containers: [local] },
    getDefaultContainerId: { id: "K1" },
    getContainerGroups: { groups: [{ id: "g1", name: "Family" }] },
    getContainerContactIds: { ids: ["c1", "c2"] },
  });
  await inShell(
    "ios",
    { CapacitorContacts: capgo.plugin, DenextContacts: denext.plugin },
    async () => {
      assertEquals(await Contacts.getDefaultContainerIdAsync(), "K1");
      assertEquals(await Contacts.getContainersAsync({ contactId: "c1" }), [local] as Any);
      await Contacts.getContainersAsync({ groupId: "g1" });
      await Contacts.getContainersAsync({ containerId: "K1" });
      await Contacts.getContainersAsync({ containerId: ["K1", "K2"] });
      await Contacts.getContainersAsync({});
      assertEquals(callsTo(denext, "getContainers"), [
        { contactId: "c1" },
        { groupId: "g1" },
        { containerIds: ["K1"] },
        { containerIds: ["K1", "K2"] },
        {},
      ]);
      const [container] = await Contacts.Container.getAll();
      assert(container instanceof Contacts.Container);
      assertEquals(container.id, "K1");
      assertEquals(await container.getName(), "iCloud");
      assertEquals(await container.getType(), "cardDAV");
      assertEquals((await container.getGroups()).map((g) => g.id), ["g1"]);
      assertEquals((await container.getContacts()).map((c) => c.id), ["c1", "c2"]);
      assertEquals((await Contacts.Container.getDefault())?.id, "K1");
    },
  );
  // A shell from before DenextContacts: containers stay unavailable.
  await inShell("ios", { CapacitorContacts: capgo.plugin }, async () => {
    await assertRejects(() => Contacts.getContainersAsync({}), Error, "DenextContacts");
  });
});

Deno.test("expo-contacts: change listeners fire on DenextContacts' contactsChanged", async () => {
  const capgo = fakePlugin(CAPGO_CONTACTS);
  const denext = fakePlugin(DENEXT_CONTACTS);
  await inShell(
    "android",
    { CapacitorContacts: capgo.plugin, DenextContacts: denext.plugin },
    async () => {
      let a = 0;
      let b = 0;
      const first = Contacts.addContactsChangeListener(() => a++);
      Contacts.addContactsChangeListener(() => b++);
      await settle();
      assertEquals(
        callsTo(denext, "watchChanges").length,
        1,
        "one native watch for every listener",
      );
      assertEquals(denext.listening(), 1);
      denext.fire("contactsChanged", {});
      assertEquals([a, b], [1, 1]);
      first.remove();
      denext.fire("contactsChanged", {});
      assertEquals([a, b], [1, 2]);
      Contacts.removeAllContactsChangeListeners();
      await settle();
      denext.fire("contactsChanged", {});
      assertEquals([a, b], [1, 2]);
      assertEquals(denext.listening(), 0, "the native listener goes with the last one");
    },
  );
});

// ---- expo-calendar --------------------------------------------------------------------------

const EBAROONI = ["listEventsInRange", "createEvent", "modifyEvent", "modifyEventWithPrompt"];
const DENEXT_CALENDAR = [
  "getEvent",
  "getAttendees",
  "createAttendee",
  "updateAttendee",
  "deleteAttendee",
  "updateEvent",
  "openEvent",
  "editEvent",
];

const EVENT = {
  id: "E1",
  calendarId: "C1",
  title: "Standup",
  location: null,
  description: null,
  url: null,
  timezone: "Europe/Berlin",
  startDate: T0,
  endDate: T0 + HOUR,
  isAllDay: false,
  alerts: [-10],
  availability: 0,
  status: "confirmed",
  organizer: null,
  creationDate: null,
  lastModifiedDate: null,
  isDetached: false,
  masterId: null,
};

/** The pinned plugin and DenextCalendar, faked. */
function calendarPlugins(denextResults: Record<string, unknown> = {}) {
  return {
    ebarooni: fakePlugin(EBAROONI, { createEvent: { id: "E9" } }),
    denext: fakePlugin(DENEXT_CALENDAR, {
      getEvent: { event: EVENT },
      updateEvent: { id: "E1" },
      openEvent: { action: "responded" },
      editEvent: { action: "saved", id: "E1" },
      getAttendees: {
        attendees: [{
          name: "Grace",
          email: "grace@example.com",
          url: "mailto:grace@example.com",
          role: "required",
          status: "accepted",
          type: "person",
          isCurrentUser: false,
        }],
      },
      createAttendee: { id: "A7" },
      updateAttendee: { id: "A7" },
      ...denextResults,
    }),
  };
}

Deno.test("expo-calendar: an event by id, and its time zone, through DenextCalendar", async () => {
  const { ebarooni, denext } = calendarPlugins();
  await inShell(
    "ios",
    { CapacitorCalendar: ebarooni.plugin, DenextCalendar: denext.plugin },
    async () => {
      const event = await Calendar.getEventAsync("E1");
      assertEquals([event.id, event.timeZone, event.startDate], [
        "E1",
        "Europe/Berlin",
        new Date(T0).toISOString(),
      ]);
      assertEquals(callsTo(denext, "getEvent"), [{ id: "E1" }]);
      assertEquals((await Calendar.ExpoCalendarEvent.get("E1")).title, "Standup");
      // The pinned plugin takes no time zone: DenextCalendar sets it after.
      assertEquals(
        await Calendar.createEventAsync("C1", { title: "Trip", timeZone: "Asia/Tokyo" }),
        "E9",
      );
      await Calendar.updateEventAsync("E1", { title: "Moved", timeZone: "UTC" }, {
        futureEvents: true,
      });
      assertEquals(callsTo(ebarooni, "modifyEvent"), [{ title: "Moved", id: "E1", span: 1 }]);
      assertEquals(callsTo(denext, "updateEvent"), [
        { id: "E9", timeZone: "Asia/Tokyo" },
        { id: "E1", timeZone: "UTC", futureEvents: true },
      ]);
    },
  );
  const missing = calendarPlugins({ getEvent: { event: null } });
  await inShell(
    "ios",
    { CapacitorCalendar: missing.ebarooni.plugin, DenextCalendar: missing.denext.plugin },
    async () => {
      const err = await assertRejects(() => Calendar.getEventAsync("E404"));
      assertEquals((err as Any).code, "E_EVENT_NOT_FOUND");
    },
  );
});

Deno.test("expo-calendar: one occurrence is changed through DenextCalendar", async () => {
  const { ebarooni, denext } = calendarPlugins({ updateEvent: { id: "X5" } });
  await inShell(
    "android",
    { CapacitorCalendar: ebarooni.plugin, DenextCalendar: denext.plugin },
    async () => {
      const id = await Calendar.updateEventAsync(
        "E1",
        {
          title: "Late",
          startDate: new Date(T0 + HOUR),
          endDate: new Date(T0 + 2 * HOUR),
          notes: "moved",
          alarms: [{ relativeOffset: -5 }],
          availability: Calendar.Availability.FREE,
        },
        { instanceStartDate: new Date(T0) },
      );
      assertEquals(id, "X5", "an Android occurrence becomes an exception with its own id");
      assertEquals(callsTo(denext, "updateEvent"), [{
        id: "E1",
        instanceStartDate: T0,
        title: "Late",
        startDate: T0 + HOUR,
        endDate: T0 + 2 * HOUR,
        notes: "moved",
        alarms: [-5],
        availability: 1,
      }]);
      assertEquals(callsTo(ebarooni, "modifyEvent"), [], "the pinned plugin is not asked");
      // The editor on one occurrence.
      assertEquals(
        await Calendar.editEventInCalendarAsync({ id: "E1", instanceStartDate: new Date(T0) }),
        { action: Calendar.CalendarDialogResultActions.saved, id: "E1" },
      );
      assertEquals(callsTo(denext, "editEvent"), [{ id: "E1", instanceStartDate: T0 }]);
      assertEquals(callsTo(ebarooni, "modifyEventWithPrompt"), []);
    },
  );
});

Deno.test("expo-calendar: the event viewer, and openEventInCalendar on Android", async () => {
  const { ebarooni, denext } = calendarPlugins();
  await inShell(
    "ios",
    { CapacitorCalendar: ebarooni.plugin, DenextCalendar: denext.plugin },
    async () => {
      assertEquals(
        await Calendar.openEventInCalendarAsync({ id: "E1", instanceStartDate: new Date(T0) }, {
          allowsEditing: true,
        }),
        { action: Calendar.CalendarDialogResultActions.responded },
      );
      const event = Object.assign(new Calendar.ExpoCalendarEvent("E1"), {});
      await event.openInCalendar({ allowsCalendarPreview: true });
      assertEquals(callsTo(denext, "openEvent"), [
        { id: "E1", instanceStartDate: T0, allowsEditing: true },
        { id: "E1", allowsCalendarPreview: true },
      ]);
      // Expo's deprecated sync call is Android only.
      assertThrows(() => Calendar.openEventInCalendar("E1"), Error, "Android only");
    },
  );
  await inShell(
    "android",
    { CapacitorCalendar: ebarooni.plugin, DenextCalendar: denext.plugin },
    async () => {
      Calendar.openEventInCalendar("E2");
      await settle();
      assertEquals(callsTo(denext, "openEvent").at(-1), { id: "E2" });
    },
  );
});

Deno.test("expo-calendar: attendees read everywhere, written on Android", async () => {
  const { ebarooni, denext } = calendarPlugins();
  const grace: Calendar.Attendee = {
    name: "Grace",
    email: "grace@example.com",
    url: "mailto:grace@example.com",
    role: Calendar.AttendeeRole.REQUIRED,
    status: Calendar.AttendeeStatus.ACCEPTED,
    type: Calendar.AttendeeType.PERSON,
    isCurrentUser: false,
  };
  await inShell(
    "ios",
    { CapacitorCalendar: ebarooni.plugin, DenextCalendar: denext.plugin },
    async () => {
      assertEquals(
        await Calendar.getAttendeesForEventAsync("E1", { instanceStartDate: new Date(T0) }),
        [grace],
      );
      const [object] = await new Calendar.ExpoCalendarEvent("E1").getAttendees();
      assert(object instanceof Calendar.ExpoCalendarAttendee);
      assertEquals(object.email, "grace@example.com");
      // EventKit's attendees are read-only, as in Expo.
      for (
        const call of [
          () => Calendar.createAttendeeAsync("E1", { email: "x@example.com" }),
          () => Calendar.updateAttendeeAsync("A1", { name: "X" }),
          () => Calendar.deleteAttendeeAsync("A1"),
        ]
      ) {
        const err = await assertRejects(call);
        assertEquals((err as Any).code, "ERR_UNAVAILABLE");
      }
    },
  );
  await inShell(
    "android",
    { CapacitorCalendar: ebarooni.plugin, DenextCalendar: denext.plugin },
    async () => {
      assertEquals(
        await Calendar.createAttendeeAsync("E1", {
          name: "Alan",
          email: "alan@example.com",
          role: Calendar.AttendeeRole.ATTENDEE,
          type: Calendar.AttendeeType.REQUIRED,
        }),
        "A7",
      );
      assertEquals(
        await Calendar.updateAttendeeAsync("A7", { status: Calendar.AttendeeStatus.DECLINED }),
        "A7",
      );
      await Calendar.deleteAttendeeAsync("A7");
      const made = await new Calendar.ExpoCalendarEvent("E1").createAttendee({
        email: "ada@example.com",
      });
      assertEquals([made.id, made.email], ["A7", "ada@example.com"]);
      await made.update({ name: "Ada" });
      assertEquals(made.name, "Ada");
      await made.delete();
      assertEquals(callsTo(denext, "createAttendee"), [
        {
          name: "Alan",
          email: "alan@example.com",
          role: "attendee",
          type: "required",
          eventId: "E1",
        },
        { email: "ada@example.com", eventId: "E1" },
      ]);
      assertEquals(callsTo(denext, "updateAttendee"), [
        { status: "declined", id: "A7" },
        { name: "Ada", id: "A7" },
      ]);
      assertEquals(callsTo(denext, "deleteAttendee"), [{ id: "A7" }, { id: "A7" }]);
    },
  );
});

Deno.test("expo-calendar: a shell without DenextCalendar keeps rejecting those calls", async () => {
  const { ebarooni } = calendarPlugins();
  await inShell("ios", { CapacitorCalendar: ebarooni.plugin }, async () => {
    for (
      const call of [
        () => Calendar.getEventAsync("E1"),
        () => Calendar.getAttendeesForEventAsync("E1"),
        () => Calendar.openEventInCalendarAsync({ id: "E1" }),
        () => Calendar.updateEventAsync("E1", {}, { instanceStartDate: new Date(T0) }),
        () => Calendar.editEventInCalendarAsync({ id: "E1", instanceStartDate: new Date(T0) }),
      ]
    ) {
      const err = await assertRejects(call);
      assertEquals((err as Any).code, "ERR_UNAVAILABLE");
    }
    // The time zone is still dropped quietly, as before.
    await Calendar.updateEventAsync("E1", { timeZone: "UTC" });
    assertEquals(callsTo(ebarooni, "modifyEvent"), [{ id: "E1", span: 0 }]);
  });
});
