// expo-calendar's `updateEventAsync(id, details, { instanceStartDate, futureEvents: true })` on
// Android: `DenextCalendar` splits the repeating series at the occurrence (EventKit's
// `EKSpan.futureEvents`) instead of refusing it. The series ends before the occurrence and a new
// event carries the rest with the changes. The recurrence arithmetic is the template's
// `DenextCalendarRecurrence.java`, compiled and run on a plain JDK against
// tests/fixtures/calendar-recurrence/CalendarRecurrenceHarness.java (where javac exists; under CI
// always). The provider calls around it run on a device only.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  CALENDAR_ANDROID_FILES,
  EXPO_SDK_TEMPLATE_VERSIONS,
} from "../src/build/expo-sdk-native-templates.ts";
import * as Calendar from "../src/expo/calendar.ts";
import { fakePlugin, inShell } from "./helpers/mobile-fakes.ts";
import { IGNORE_WITHOUT_JDK, requireJdk } from "./_jdk.ts";

const PLUGIN = CALENDAR_ANDROID_FILES["DenextCalendarPlugin.java"];
const RECURRENCE = CALENDAR_ANDROID_FILES["DenextCalendarRecurrence.java"];
const HARNESS =
  new URL("./fixtures/calendar-recurrence/CalendarRecurrenceHarness.java", import.meta.url)
    .pathname;

Deno.test("calendar template generation 2: Android splits a series instead of refusing futureEvents", () => {
  assertEquals(EXPO_SDK_TEMPLATE_VERSIONS.calendar, 2);
  assert(RECURRENCE, "DenextCalendarRecurrence.java ships with the plugin");
  assert(!PLUGIN.includes("is not supported on Android"), "the refusal is gone");
  const branch = PLUGIN.slice(PLUGIN.indexOf('call.getBoolean("futureEvents", false)'));
  assertStringIncludes(branch.slice(0, 300), "splitSeries(resolver, id, Math.round(at), values)");
  // The rest of the series: the original's columns, a duration (a repeating event has no end),
  // the remainder of the rule, its attendees and reminders; the old series ends before it.
  for (
    const needle of [
      "DenextCalendarRecurrence.ruleFrom(",
      "DenextCalendarRecurrence.ruleBefore(",
      "DenextCalendarRecurrence.splitDates(",
      "next.remove(Events.DTEND)",
      "copyGuestsAndReminders(resolver, id, created)",
      'Events.ORIGINAL_INSTANCE_TIME + " >= ?"',
    ]
  ) assertStringIncludes(PLUGIN, needle);
});

Deno.test("expo-calendar (Android): futureEvents on an occurrence resolves the new series' id", async () => {
  const ebarooni = fakePlugin(["modifyEvent", "requestFullCalendarAccess"], {});
  const denext = fakePlugin(["updateEvent"], { updateEvent: { id: "N7" } });
  await inShell(
    "android",
    { CapacitorCalendar: ebarooni.plugin, DenextCalendar: denext.plugin },
    async () => {
      const t0 = Date.UTC(2026, 9, 7, 12);
      const id = await Calendar.updateEventAsync(
        "E1",
        { title: "Moved", startDate: new Date(t0 + 3_600_000) },
        { instanceStartDate: new Date(t0), futureEvents: true },
      );
      assertEquals(id, "N7");
      assertEquals(denext.calls.filter(([m]) => m === "updateEvent").map(([, a]) => a), [{
        id: "E1",
        instanceStartDate: t0,
        title: "Moved",
        startDate: t0 + 3_600_000,
        futureEvents: true,
      }]);
      assertEquals(ebarooni.calls.filter(([m]) => m === "modifyEvent"), []);
    },
  );
});

async function run(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`${cmd} failed:\n${text}`);
  return text;
}

Deno.test({
  name:
    "calendar (Android): the recurrence arithmetic compiles and splits rules, dates and durations",
  ignore: IGNORE_WITHOUT_JDK,
  async fn() {
    requireJdk();
    const dir = await Deno.makeTempDir({ prefix: "denext_calendar_recurrence_" });
    try {
      const pkg = join(dir, "src", "dev", "denext", "calendar");
      await Deno.mkdir(pkg, { recursive: true });
      await Deno.writeTextFile(join(pkg, "DenextCalendarRecurrence.java"), RECURRENCE);
      const classes = join(dir, "classes");
      await run("javac", ["-d", classes, join(pkg, "DenextCalendarRecurrence.java"), HARNESS]);
      const out = await run("java", ["-cp", classes, "CalendarRecurrenceHarness"]);
      const failed = out.split("\n").filter((line) => line.startsWith("FAIL"));
      assertEquals(failed, [], out);
      assertStringIncludes(out, "ok ruleFrom ends a COUNT rule at the last occurrence");
      assertStringIncludes(out, "all passed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
