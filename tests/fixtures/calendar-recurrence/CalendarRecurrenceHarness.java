// Runs the recurrence arithmetic of the generated DenextCalendarRecurrence.java (the Android
// half of expo-calendar's `futureEvents` split) on a plain JDK. tests/calendar-recurrence.test.ts
// writes the template beside this file, compiles both with javac and runs this with java; a
// failed check exits 1 and names it.

import dev.denext.calendar.DenextCalendarRecurrence;
import java.util.Arrays;
import java.util.TimeZone;

public final class CalendarRecurrenceHarness {
    private static int failures = 0;

    private static void check(String name, Object actual, Object expected) {
        boolean same = actual == null ? expected == null : actual.equals(expected);
        if (same) {
            System.out.println("ok " + name);
        } else {
            failures++;
            System.out.println("FAIL " + name + ": expected <" + expected + "> but was <" + actual + ">");
        }
    }

    public static void main(String[] args) {
        TimeZone utc = TimeZone.getTimeZone("UTC");
        TimeZone ny = TimeZone.getTimeZone("America/New_York");
        long day = DenextCalendarRecurrence.DAY;
        // 2026-10-07T12:00:00Z
        long at = 1791374400000L;
        check("formatDate timed", DenextCalendarRecurrence.formatDate(at, false), "20261007T120000Z");
        check("formatDate all day", DenextCalendarRecurrence.formatDate(at - 12 * 3_600_000L, true), "20261007");
        check("parseDate UTC", DenextCalendarRecurrence.parseDate("20261007T120000Z", ny), at);
        check("parseDate floating in the zone", DenextCalendarRecurrence.parseDate("20261007T080000", ny), at);
        check("parseDate date", DenextCalendarRecurrence.parseDate("20261007", ny), at - 12 * 3_600_000L);
        check("parseDate unreadable", DenextCalendarRecurrence.parseDate("soon", ny), null);
        check("part", DenextCalendarRecurrence.part("FREQ=WEEKLY;COUNT=10;BYDAY=WE", "count"), "10");
        check("part missing", DenextCalendarRecurrence.part("FREQ=WEEKLY", "UNTIL"), null);

        // Before the split: COUNT / UNTIL give way to an UNTIL a second before the occurrence.
        check(
            "ruleBefore replaces COUNT",
            DenextCalendarRecurrence.ruleBefore("FREQ=WEEKLY;COUNT=10;BYDAY=WE", at, false),
            "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261007T115959Z"
        );
        check(
            "ruleBefore replaces a later UNTIL",
            DenextCalendarRecurrence.ruleBefore("FREQ=DAILY;UNTIL=20271231T000000Z", at, false),
            "FREQ=DAILY;UNTIL=20261007T115959Z"
        );
        check(
            "ruleBefore all day ends the day before",
            DenextCalendarRecurrence.ruleBefore("FREQ=DAILY", at - 12 * 3_600_000L, true),
            "FREQ=DAILY;UNTIL=20261006"
        );

        // From the split on.
        check(
            "ruleFrom keeps an unbounded rule",
            DenextCalendarRecurrence.ruleFrom("FREQ=WEEKLY;BYDAY=WE", null, 0, false, utc),
            "FREQ=WEEKLY;BYDAY=WE"
        );
        check(
            "ruleFrom ends a COUNT rule at the last occurrence",
            DenextCalendarRecurrence.ruleFrom("FREQ=WEEKLY;COUNT=10", at + 3 * 7 * day, 0, false, utc),
            "FREQ=WEEKLY;UNTIL=20261028T120000Z"
        );
        check(
            "ruleFrom shifts the end with a moved start",
            DenextCalendarRecurrence.ruleFrom("FREQ=WEEKLY;COUNT=10", at, 3_600_000L, false, utc),
            "FREQ=WEEKLY;UNTIL=20261007T130000Z"
        );
        check(
            "ruleFrom shifts an UNTIL rule's bound",
            DenextCalendarRecurrence.ruleFrom("FREQ=DAILY;UNTIL=20261010T120000Z", null, 3_600_000L, false, utc),
            "FREQ=DAILY;UNTIL=20261010T130000Z"
        );
        check(
            "ruleFrom all day writes a date",
            DenextCalendarRecurrence.ruleFrom("FREQ=DAILY;COUNT=3", at - 12 * 3_600_000L + 2 * day, 0, true, utc),
            "FREQ=DAILY;UNTIL=20261009"
        );

        // EXDATE / RDATE divided at the occurrence.
        check(
            "splitDates divides and shifts",
            Arrays.asList(
                DenextCalendarRecurrence.splitDates(
                    "20260930T120000Z,20261014T120000Z,20261021T120000Z",
                    at,
                    3_600_000L,
                    false,
                    utc
                )
            ),
            Arrays.asList("20260930T120000Z", "20261014T130000Z,20261021T130000Z")
        );
        check(
            "splitDates keeps a TZID line's earlier values as written",
            Arrays.asList(
                DenextCalendarRecurrence.splitDates("TZID=America/New_York;20260930T080000,20261014T080000", at, 0, false, utc)
            ),
            Arrays.asList("TZID=America/New_York;20260930T080000", "20261014T120000Z")
        );
        check(
            "splitDates empty",
            Arrays.asList(DenextCalendarRecurrence.splitDates(null, at, 0, false, utc)),
            Arrays.asList((String) null, (String) null)
        );
        check(
            "splitDates all after",
            Arrays.asList(DenextCalendarRecurrence.splitDates("20261014", at, 0, true, utc)),
            Arrays.asList(null, "20261014")
        );
        check(
            "appendDates adds cancelled occurrences",
            DenextCalendarRecurrence.appendDates("20261014T120000Z", Arrays.asList(at + 14 * day), false),
            "20261014T120000Z,20261021T120000Z"
        );
        check("appendDates nothing", DenextCalendarRecurrence.appendDates(null, Arrays.asList(), false), null);
        check("duration timed", DenextCalendarRecurrence.duration(5_400_000L, false), "P5400S");
        check("duration all day", DenextCalendarRecurrence.duration(day, true), "P1D");
        if (failures > 0) {
            System.out.println(failures + " failed");
            System.exit(1);
        }
        System.out.println("all passed");
    }
}
