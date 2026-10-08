// expo-calendar over @ebarooni/capacitor-calendar (`CapacitorCalendar`): calendars, events,
// reminders, permissions and the native creation prompt in a faked shell, and the web
// fallback (ERR_UNAVAILABLE data calls, undetermined permissions).

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import * as Calendar from "../src/expo/calendar.ts";
import { type Any, fakePlugin, inShell, mount, settle } from "./helpers/mobile-fakes.ts";

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const HOUR = 3_600_000;

const nativeCalendar = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Cal ${id}`,
  internalTitle: null,
  color: "#FF0000",
  isImmutable: false,
  allowsContentModifications: true,
  type: 1,
  source: { type: 2, id: "src1", title: "iCloud" },
  visible: true,
  accountName: null,
  ownerAccount: null,
  maxReminders: null,
  location: null,
  ...extra,
});

const nativeEvent = (id: string, calendarId: string, extra: Record<string, unknown> = {}) => ({
  id,
  calendarId,
  title: `Event ${id}`,
  location: "Office",
  description: "notes",
  url: null,
  timezone: "Europe/Berlin",
  startDate: T0,
  endDate: T0 + HOUR,
  isAllDay: false,
  alerts: [-15],
  availability: 0,
  status: "confirmed",
  organizer: "boss@example.com",
  creationDate: T0 - HOUR,
  lastModifiedDate: null,
  isDetached: null,
  masterId: id,
  attendees: [],
  ...extra,
});

const nativeReminder = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Todo ${id}`,
  listId: "L1",
  isCompleted: false,
  priority: 0,
  notes: null,
  location: null,
  url: null,
  startDate: null,
  dueDate: T0,
  completionDate: null,
  recurrence: [],
  alerts: [],
  ...extra,
});

const METHODS = [
  "checkAllPermissions",
  "requestFullCalendarAccess",
  "requestWriteOnlyCalendarAccess",
  "requestFullRemindersAccess",
  "listCalendars",
  "getDefaultCalendar",
  "selectCalendarsWithPrompt",
  "fetchAllCalendarSources",
  "createCalendar",
  "modifyCalendar",
  "deleteCalendar",
  "listEventsInRange",
  "createEvent",
  "modifyEvent",
  "deleteEvent",
  "createEventWithPrompt",
  "modifyEventWithPrompt",
  "getRemindersLists",
  "createRemindersList",
  "updateRemindersList",
  "deleteRemindersList",
  "getRemindersFromLists",
  "getReminderById",
  "createReminder",
  "modifyReminder",
  "deleteReminder",
];

function calendarPlugin(results: Record<string, unknown> = {}) {
  return fakePlugin(METHODS, {
    listCalendars: { result: [nativeCalendar("C1"), nativeCalendar("C2")] },
    getRemindersLists: { result: [nativeCalendar("L1", { type: 0, source: null })] },
    getDefaultCalendar: { result: nativeCalendar("C1") },
    fetchAllCalendarSources: { result: [{ type: 0, id: "local", title: "On My iPhone" }] },
    listEventsInRange: {
      result: [nativeEvent("E1", "C1"), nativeEvent("E2", "C2", { masterId: "S2" })],
    },
    createEvent: { id: "E9", ics: null },
    createCalendar: { id: "C9" },
    createRemindersList: { id: "L9" },
    getRemindersFromLists: {
      result: [
        nativeReminder("R1"),
        nativeReminder("R2", {
          isCompleted: true,
          dueDate: T0 + 10 * HOUR,
          completionDate: T0 + HOUR,
          recurrence: [{ frequency: "weekly", interval: 2 }],
        }),
      ],
    },
    getReminderById: { result: nativeReminder("R1") },
    createReminder: { id: "R9" },
    ...results,
  });
}

function callsTo(fake: ReturnType<typeof fakePlugin>, method: string): unknown[] {
  return fake.calls.filter(([m]) => m === method).map(([, arg]) => arg);
}

Deno.test("expo-calendar: calendars map to Expo's shape; reminders lists join on iOS", async () => {
  const fake = calendarPlugin();
  await inShell("ios", { CapacitorCalendar: fake.plugin }, async () => {
    assertEquals(await Calendar.isAvailableAsync(), true);
    const all = await Calendar.getCalendarsAsync();
    assertEquals(all.map((c) => [c.id, c.entityType]), [
      ["C1", "event"],
      ["C2", "event"],
      ["L1", "reminder"],
    ]);
    const [c1] = all;
    assertEquals(c1.title, "Cal C1");
    assertEquals(c1.color, "#FF0000");
    assertEquals(c1.type, Calendar.CalendarType.CALDAV);
    assertEquals(c1.source, { id: "src1", name: "iCloud", type: "caldav", isLocalAccount: false });
    assertEquals(c1.sourceId, "src1");
    assertEquals(c1.allowsModifications, true);
    assertEquals(all[2].type, Calendar.CalendarType.LOCAL);
    assertEquals(all[2].source.type, "unknown");

    const events = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    assertEquals(events.map((c) => c.id), ["C1", "C2"]);
    const lists = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
    assertEquals(lists.map((c) => c.id), ["L1"]);

    const def = await Calendar.getDefaultCalendarAsync();
    assertEquals([def.id, def.isPrimary], ["C1", true]);
    assertEquals(await Calendar.getSourcesAsync(), [
      { id: "local", name: "On My iPhone", type: "local", isLocalAccount: true },
    ]);
    await assertRejects(() => Calendar.getSourceAsync("nope"), Error, "no source");

    const objects = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
    assertInstanceOf(objects[0], Calendar.ExpoCalendar);
    assertEquals(objects[1].id, "C2");
    const got = await Calendar.ExpoCalendar.get("L1");
    assertEquals(got.entityType, Calendar.EntityTypes.REMINDER);
  });
});

Deno.test("expo-calendar: creating, updating and deleting calendars and reminders lists", async () => {
  const fake = calendarPlugin();
  await inShell("ios", { CapacitorCalendar: fake.plugin }, async () => {
    assertEquals(
      await Calendar.createCalendarAsync({ title: "Work", color: "#00FF00", sourceId: "local" }),
      "C9",
    );
    assertEquals(callsTo(fake, "createCalendar"), [
      { title: "Work", color: "#00FF00", sourceId: "local" },
    ]);
    assertEquals(
      await Calendar.createCalendarAsync({
        title: "Chores",
        entityType: Calendar.EntityTypes.REMINDER,
      }),
      "L9",
    );
    assertEquals(callsTo(fake, "createRemindersList"), [{ title: "Chores" }]);

    assertEquals(await Calendar.updateCalendarAsync("C1", { title: "Renamed" }), "C1");
    assertEquals(callsTo(fake, "modifyCalendar"), [{ id: "C1", title: "Renamed" }]);
    await Calendar.updateCalendarAsync("L1", { color: "#0000FF" });
    assertEquals(callsTo(fake, "updateRemindersList"), [{ id: "L1", color: "#0000FF" }]);

    await Calendar.deleteCalendarAsync("C2");
    await Calendar.deleteCalendarAsync("L1");
    assertEquals(callsTo(fake, "deleteCalendar"), [{ id: "C2" }]);
    assertEquals(callsTo(fake, "deleteRemindersList"), [{ id: "L1" }]);

    const created = await Calendar.createCalendar({ title: "New" });
    assertInstanceOf(created, Calendar.ExpoCalendar);
    assertEquals([created.id, created.title], ["C9", "New"]);
  });
});

Deno.test("expo-calendar: events list, map, and round-trip to the plugin's fields", async () => {
  const fake = calendarPlugin();
  await inShell("ios", { CapacitorCalendar: fake.plugin }, async () => {
    const start = new Date(T0 - HOUR);
    const end = new Date(T0 + 2 * HOUR);
    const events = await Calendar.getEventsAsync(["C1"], start, end);
    assertEquals(callsTo(fake, "listEventsInRange"), [{ from: T0 - HOUR, to: T0 + 2 * HOUR }]);
    assertEquals(events.length, 1);
    const [e] = events;
    assertEquals(e.id, "E1");
    assertEquals(e.calendarId, "C1");
    assertEquals(e.startDate, new Date(T0).toISOString());
    assertEquals(e.endDate, new Date(T0 + HOUR).toISOString());
    assertEquals(e.creationDate, new Date(T0 - HOUR).toISOString());
    assertEquals(e.notes, "notes");
    assertEquals(e.timeZone, "Europe/Berlin");
    assertEquals(e.alarms, [{ relativeOffset: -15 }]);
    assertEquals(e.availability, Calendar.Availability.BUSY);
    assertEquals(e.status, Calendar.EventStatus.CONFIRMED);
    assertEquals(e.organizerEmail, "boss@example.com");
    assertEquals(e.recurrenceRule, null);
    assertEquals(e.originalId, undefined);

    const both = await Calendar.getEventsAsync([], start, end);
    assertEquals(both.map((x) => [x.id, x.originalId]), [["E1", undefined], ["E2", "S2"]]);

    const id = await Calendar.createEventAsync("C1", {
      title: "Standup",
      startDate: new Date(T0),
      endDate: new Date(T0 + HOUR).toISOString(),
      allDay: false,
      notes: "daily",
      alarms: [{ relativeOffset: -10 }, { absoluteDate: "2026-01-01" }],
      availability: Calendar.Availability.FREE,
      recurrenceRule: {
        frequency: Calendar.Frequency.WEEKLY,
        interval: 1,
        occurrence: 4,
        daysOfTheWeek: [
          { dayOfTheWeek: Calendar.DayOfTheWeek.Sunday },
          { dayOfTheWeek: Calendar.DayOfTheWeek.Monday },
        ],
      },
    });
    assertEquals(id, "E9");
    assertEquals(callsTo(fake, "createEvent"), [{
      title: "Standup",
      startDate: T0,
      endDate: T0 + HOUR,
      isAllDay: false,
      description: "daily",
      alerts: [-10],
      availability: 1,
      recurrence: { frequency: "weekly", interval: 1, count: 4, byWeekDay: [7, 1] },
      calendarId: "C1",
    }]);

    assertEquals(
      await Calendar.updateEventAsync("E1", { title: "Moved" }, { futureEvents: true }),
      "E1",
    );
    assertEquals(callsTo(fake, "modifyEvent"), [{ title: "Moved", id: "E1", span: 1 }]);
    await assertRejects(
      () => Calendar.updateEventAsync("E1", {}, { instanceStartDate: new Date(T0) }),
      Error,
      "single occurrence",
    );

    await Calendar.deleteEventAsync("E1");
    await Calendar.deleteEventAsync("E2", { instanceStartDate: new Date(T0) });
    assertEquals(callsTo(fake, "deleteEvent"), [
      { id: "E1", span: 0 },
      { id: "E2", span: 0, instanceDate: T0 },
    ]);

    const err = await assertRejects(() => Calendar.getEventAsync("E1"));
    assertEquals((err as Any).code, "ERR_UNAVAILABLE");
    const one = await Calendar.getEventAsync("E2", { instanceStartDate: new Date(T0) });
    assertEquals(one.id, "E2");
    await assertRejects(
      () => Calendar.getEventAsync("E7", { instanceStartDate: new Date(T0) }),
      Error,
      "no event",
    );
  });
});

Deno.test("expo-calendar: the object API wraps the same calls", async () => {
  const fake = calendarPlugin();
  await inShell("ios", { CapacitorCalendar: fake.plugin }, async () => {
    const [cal] = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
    const listed = await cal.listEvents(new Date(T0), new Date(T0 + HOUR));
    assertEquals(listed.map((e) => e.id), ["E1"]);
    assertInstanceOf(listed[0], Calendar.ExpoCalendarEvent);

    const created = await cal.createEvent({ title: "New", startDate: new Date(T0) });
    assertEquals([created.id, created.calendarId, created.title], ["E9", "C1", "New"]);
    await created.update({ title: "Newer" });
    assertEquals(created.title, "Newer");
    await created.delete();
    assertEquals(callsTo(fake, "deleteEvent"), [{ id: "E9", span: 0 }]);

    const across = await Calendar.listEvents([cal, "C2"], new Date(T0), new Date(T0 + HOUR));
    assertEquals(across.map((e) => e.id), ["E1", "E2"]);

    await cal.update({ title: "Home" });
    assertEquals(cal.title, "Home");
    await cal.delete();
    assertEquals(callsTo(fake, "deleteCalendar"), [{ id: "C1" }]);
  });

  const picker = calendarPlugin({ selectCalendarsWithPrompt: { result: [nativeCalendar("C2")] } });
  await inShell("ios", { CapacitorCalendar: picker.plugin }, async () => {
    const chosen = await Calendar.presentPicker();
    assertEquals(chosen?.id, "C2");
    assertEquals(callsTo(picker, "selectCalendarsWithPrompt"), [{ multiple: false }]);
  });
  const canceled = calendarPlugin({ selectCalendarsWithPrompt: { result: [] } });
  await inShell("ios", { CapacitorCalendar: canceled.plugin }, async () => {
    assertEquals(await Calendar.presentPicker(), null);
  });
});

Deno.test("expo-calendar: the native creation prompt and editor report Expo's actions", async () => {
  const saved = calendarPlugin({ createEventWithPrompt: { id: "E5", ics: null } });
  await inShell("ios", { CapacitorCalendar: saved.plugin }, async () => {
    assertEquals(
      await Calendar.createEventInCalendarAsync({ title: "Party", startDate: new Date(T0) }),
      { action: Calendar.CalendarDialogResultActions.saved, id: "E5" },
    );
    assertEquals(callsTo(saved, "createEventWithPrompt"), [{ title: "Party", startDate: T0 }]);
    const [cal] = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
    await cal.addEventWithForm({ title: "Form" });
    assertEquals(callsTo(saved, "createEventWithPrompt")[1], { title: "Form", calendarId: "C1" });
  });
  const canceled = calendarPlugin({ createEventWithPrompt: { id: null, ics: null } });
  await inShell("ios", { CapacitorCalendar: canceled.plugin }, async () => {
    assertEquals(await Calendar.createEventInCalendarAsync(), {
      action: Calendar.CalendarDialogResultActions.canceled,
      id: null,
    });
  });
  await inShell("android", { CapacitorCalendar: canceled.plugin }, async () => {
    assertEquals(await Calendar.createEventInCalendarAsync(), {
      action: Calendar.CalendarDialogResultActions.done,
      id: null,
    });
  });

  const edit = calendarPlugin({ modifyEventWithPrompt: { result: "saved" } });
  await inShell("ios", { CapacitorCalendar: edit.plugin }, async () => {
    assertEquals(await Calendar.editEventInCalendarAsync({ id: "E1" }), {
      action: Calendar.CalendarDialogResultActions.saved,
      id: "E1",
    });
    assertEquals(callsTo(edit, "modifyEventWithPrompt"), [{ id: "E1" }]);
  });
  const editAndroid = calendarPlugin({ modifyEventWithPrompt: { result: null } });
  await inShell("android", { CapacitorCalendar: editAndroid.plugin }, async () => {
    assertEquals(await Calendar.editEventInCalendarAsync({ id: "E1" }), {
      action: Calendar.CalendarDialogResultActions.done,
      id: "E1",
    });
  });
});

Deno.test("expo-calendar: reminders on iOS; ERR_UNAVAILABLE on Android", async () => {
  const fake = calendarPlugin();
  await inShell("ios", { CapacitorCalendar: fake.plugin }, async () => {
    const incomplete = await Calendar.getRemindersAsync(
      [],
      Calendar.ReminderStatus.INCOMPLETE,
      null,
      null,
    );
    assertEquals(callsTo(fake, "getRemindersFromLists"), [{ listIds: ["L1"] }]);
    assertEquals(incomplete.map((r) => r.id), ["R1"]);
    assertEquals(incomplete[0].dueDate, new Date(T0).toISOString());
    assertEquals(incomplete[0].calendarId, "L1");

    const done = await Calendar.getRemindersAsync(["L1"], Calendar.ReminderStatus.COMPLETED);
    assertEquals(done.map((r) => [r.id, r.completed]), [["R2", true]]);
    assertEquals(done[0].recurrenceRule, {
      frequency: Calendar.Frequency.WEEKLY,
      interval: 2,
      endDate: undefined,
    });
    const all = await Calendar.getRemindersAsync(["L1"], null, new Date(T0 - 1), new Date(T0 + 1));
    assertEquals(all.map((r) => r.id), ["R1"], "a range filters on the due date");

    assertEquals((await Calendar.getReminderAsync("R1")).title, "Todo R1");
    assertEquals(
      await Calendar.createReminderAsync("L1", { title: "Buy milk", dueDate: new Date(T0) }),
      "R9",
    );
    assertEquals(callsTo(fake, "createReminder"), [
      { title: "Buy milk", dueDate: T0, listId: "L1" },
    ]);
    await Calendar.updateReminderAsync("R1", { completed: true });
    assertEquals(callsTo(fake, "modifyReminder"), [{ isCompleted: true, id: "R1" }]);
    await Calendar.deleteReminderAsync("R1");
    assertEquals(callsTo(fake, "deleteReminder"), [{ id: "R1" }]);

    const reminder = await Calendar.ExpoCalendarReminder.get("R1");
    assertInstanceOf(reminder, Calendar.ExpoCalendarReminder);
    await reminder.update({ title: "Renamed" });
    assertEquals(reminder.title, "Renamed");
  });
  await inShell("android", { CapacitorCalendar: fake.plugin }, async () => {
    const err = await assertRejects(() => Calendar.getReminderAsync("R1"));
    assertEquals((err as Any).code, "ERR_UNAVAILABLE");
    await assertRejects(() => Calendar.requestRemindersPermissionsAsync(), Error, "iOS only");
  });
});

Deno.test("expo-calendar: permissions map the plugin's states", async () => {
  const states = {
    readCalendar: "granted",
    writeCalendar: "granted",
    readReminders: "prompt",
    writeReminders: "denied",
  };
  const fake = calendarPlugin({
    checkAllPermissions: { result: states },
    requestFullCalendarAccess: { result: "denied" },
    requestWriteOnlyCalendarAccess: { result: "granted" },
    requestFullRemindersAccess: { result: "granted" },
  });
  await inShell("ios", { CapacitorCalendar: fake.plugin }, async () => {
    const cal = await Calendar.getCalendarPermissionsAsync();
    assertEquals(cal, {
      status: "granted",
      expires: "never",
      granted: true,
      canAskAgain: true,
    } as Any);
    const rem = await Calendar.getRemindersPermissionsAsync();
    assertEquals([rem.status, rem.canAskAgain], ["denied", false]);
    const full = await Calendar.requestCalendarPermissionsAsync();
    assertEquals([full.status, full.granted], ["denied", false]);
    assertEquals((await Calendar.requestPermissionsAsync()).status, "denied");
    assertEquals((await Calendar.requestCalendarPermissions(true)).status, "granted");
    assertEquals((await Calendar.requestRemindersPermissions()).status, "granted");
    assertEquals((await Calendar.getCalendarPermissions(true)).status, "granted");
  });
  const partial = calendarPlugin({
    checkAllPermissions: {
      result: { readCalendar: "prompt", writeCalendar: "granted" },
    },
  });
  await inShell("ios", { CapacitorCalendar: partial.plugin }, async () => {
    assertEquals((await Calendar.getCalendarPermissions()).status, "undetermined");
    assertEquals((await Calendar.getCalendarPermissions(true)).status, "granted");
  });
});

Deno.test("expo-calendar: on the web data calls reject and permissions are undetermined", async () => {
  assertEquals(await Calendar.isAvailableAsync(), false);
  for (
    const call of [
      () => Calendar.getCalendarsAsync(),
      () => Calendar.getEventsAsync([], new Date(), new Date()),
      () => Calendar.createEventAsync("C1", {}),
      () => Calendar.createEventInCalendarAsync(),
      () => Calendar.getRemindersAsync([], null),
      () => Calendar.getCalendars(),
      () => Calendar.presentPicker(),
      () => Calendar.ExpoCalendar.get("C1"),
      () => Calendar.getAttendeesForEventAsync("E1"),
      () => Calendar.openEventInCalendarAsync({ id: "E1" }),
    ]
  ) {
    const err = await assertRejects(call);
    assertEquals((err as Any).code, "ERR_UNAVAILABLE");
  }
  const undetermined: Any = {
    status: "undetermined",
    expires: "never",
    granted: false,
    canAskAgain: true,
  };
  assertEquals(await Calendar.getCalendarPermissionsAsync(), undetermined);
  assertEquals(await Calendar.requestCalendarPermissionsAsync(), undetermined);
  assertEquals(await Calendar.getRemindersPermissions(), undetermined);
  assertEquals(await Calendar.requestRemindersPermissions(), undetermined);

  let hook: Any = null;
  mount(() => {
    hook = Calendar.useCalendarPermissions({ get: false });
    return null;
  });
  await settle();
  assertEquals(hook[0], null, "get: false skips the read on mount");
  assertEquals(await hook[2](), undetermined);
  assertEquals(await hook[1](), undetermined);
});

Deno.test("expo-calendar: enums carry Expo's values", () => {
  assertEquals(Calendar.EntityTypes.REMINDER, "reminder");
  assertEquals(Calendar.Availability.NOT_SUPPORTED, "notSupported");
  assertEquals(Calendar.AttendeeRole.NON_PARTICIPANT, "nonParticipant");
  assertEquals(Calendar.AttendeeStatus.IN_PROCESS, "inProcess");
  assertEquals(Calendar.DayOfTheWeek.Saturday, 7);
  assertEquals(Calendar.MonthOfTheYear.December, 12);
  assertEquals(Calendar.CalendarAccessLevel.FREEBUSY, "freebusy");
  assertEquals(Calendar.SourceType.MOBILEME, "mobileme");
});
