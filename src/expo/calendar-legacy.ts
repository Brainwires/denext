/**
 * `expo-calendar/legacy` for denext: Expo's legacy function API (`getCalendarsAsync`,
 * `getEventsAsync`, `createEventAsync`, …, the enums and the permission calls), the entry SDK 58
 * keeps for apps that have not moved to the object API. It is the same implementation
 * `denext/expo/calendar` exports from its main entry (where Expo 58's legacy functions throw and
 * denext's work), over `@ebarooni/capacitor-calendar` (`denext mobile add calendar`), with the
 * same limits: attendees, opening an event in the calendar app and editing a single occurrence
 * reject with `ERR_UNAVAILABLE`, and off the shell every data call does too.
 *
 * @example
 * ```ts
 * import * as Calendar from "denext/expo/calendar/legacy";
 *
 * const { granted } = await Calendar.requestCalendarPermissionsAsync();
 * if (granted) {
 *   const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
 * }
 * ```
 *
 * @module
 */

export {
  AlarmMethod,
  AttendeeRole,
  AttendeeStatus,
  AttendeeType,
  Availability,
  CalendarAccessLevel,
  CalendarDialogResultActions,
  CalendarType,
  createAttendeeAsync,
  createCalendarAsync,
  createEventAsync,
  createEventInCalendarAsync,
  createReminderAsync,
  DayOfTheWeek,
  deleteAttendeeAsync,
  deleteCalendarAsync,
  deleteEventAsync,
  deleteReminderAsync,
  editEventInCalendarAsync,
  EntityTypes,
  EventAccessLevel,
  EventStatus,
  Frequency,
  getAttendeesForEventAsync,
  getCalendarPermissionsAsync,
  getCalendarsAsync,
  getDefaultCalendarAsync,
  getEventAsync,
  getEventsAsync,
  getReminderAsync,
  getRemindersAsync,
  getRemindersPermissionsAsync,
  getSourceAsync,
  getSourcesAsync,
  isAvailableAsync,
  MonthOfTheYear,
  openEventInCalendar,
  openEventInCalendarAsync,
  ReminderStatus,
  requestCalendarPermissionsAsync,
  requestPermissionsAsync,
  requestRemindersPermissionsAsync,
  SourceType,
  updateAttendeeAsync,
  updateCalendarAsync,
  updateEventAsync,
  updateReminderAsync,
  useCalendarPermissions,
  useRemindersPermissions,
} from "./calendar.ts";
export { PermissionStatus } from "./internal/common.ts";
export type {
  Alarm,
  AlarmLocation,
  Attendee,
  Calendar,
  CalendarDialogParams,
  DaysOfTheWeek,
  DialogEventResult,
  Event,
  OpenEventDialogResult,
  OpenEventPresentationOptions,
  Organizer,
  PermissionExpiration,
  PermissionHookOptions,
  PermissionResponse,
  PresentationOptions,
  RecurrenceRule,
  RecurringEventOptions,
  Reminder,
  Source,
} from "./calendar.ts";
