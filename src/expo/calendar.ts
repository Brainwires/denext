/**
 * `expo-calendar` for denext: the device's calendars, events and (iOS) reminders over
 * `@ebarooni/capacitor-calendar` 8 (Capacitor 8, registered as `CapacitorCalendar`,
 * installed by `denext mobile add calendar`).
 *
 * Both of Expo's APIs are here: the object API (`getCalendars()` → {@linkcode ExpoCalendar}
 * with `listEvents` / `createEvent` / …, {@linkcode ExpoCalendarEvent},
 * {@linkcode ExpoCalendarReminder}) and the legacy function API (`getCalendarsAsync`,
 * `createEventAsync`, …), which works here as it does from `expo-calendar/legacy`. Values
 * use Expo's legacy shapes; dates come back as ISO strings.
 *
 * What the plugin cannot do rejects with `ERR_UNAVAILABLE`: attendees, opening an event in
 * the calendar app, looking an event up by id without its start
 * (`recurringEventOptions.instanceStartDate`), and editing a single occurrence. The plugin
 * does not report an event's recurrence rule (`recurrenceRule` reads `null`), an event's
 * time zone cannot be set, and reminders exist on iOS only. Off the shell every data call
 * rejects with `ERR_UNAVAILABLE` and the permissions read `undetermined`, as in Expo's web
 * build.
 *
 * @example
 * ```ts
 * import * as Calendar from "denext/expo/calendar";
 *
 * const { granted } = await Calendar.requestCalendarPermissions();
 * if (granted) {
 *   const [calendar] = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
 *   await calendar.createEvent({ title: "Lunch", startDate: new Date(), endDate: new Date() });
 * }
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import {
  CodedError,
  createPermissionHook,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  unavailable,
} from "./internal/common.ts";

export type { PermissionExpiration, PermissionHookOptions, PermissionResponse, PermissionStatus };

const PKG = "expo-calendar";
const NEEDS_SHELL = "It needs the Capacitor shell with `denext mobile add calendar`.";
const IOS_ONLY = "Reminders exist on iOS only.";

// ---- Enums (Expo's values) ------------------------------------------------------------------

/** What a calendar holds. */
export enum EntityTypes {
  /** Events. */
  EVENT = "event",
  /** Reminders (iOS). */
  REMINDER = "reminder",
}

/** How often a recurrence repeats. */
export enum Frequency {
  /** Every day. */
  DAILY = "daily",
  /** Every week. */
  WEEKLY = "weekly",
  /** Every month. */
  MONTHLY = "monthly",
  /** Every year. */
  YEARLY = "yearly",
}

/** An event's free/busy state. */
export enum Availability {
  /** The calendar does not support availability. */
  NOT_SUPPORTED = "notSupported",
  /** Busy. */
  BUSY = "busy",
  /** Free. */
  FREE = "free",
  /** Tentative. */
  TENTATIVE = "tentative",
  /** Unavailable. */
  UNAVAILABLE = "unavailable",
}

/** A calendar's kind (iOS). */
export enum CalendarType {
  /** On the device. */
  LOCAL = "local",
  /** CalDAV. */
  CALDAV = "caldav",
  /** Exchange. */
  EXCHANGE = "exchange",
  /** A subscribed calendar. */
  SUBSCRIBED = "subscribed",
  /** The birthdays calendar. */
  BIRTHDAYS = "birthdays",
  /** Not known. */
  UNKNOWN = "unknown",
}

/** An event's status. */
export enum EventStatus {
  /** No status. */
  NONE = "none",
  /** Confirmed. */
  CONFIRMED = "confirmed",
  /** Tentative. */
  TENTATIVE = "tentative",
  /** Canceled. */
  CANCELED = "canceled",
}

/** A calendar source's kind (iOS). */
export enum SourceType {
  /** On the device. */
  LOCAL = "local",
  /** Exchange. */
  EXCHANGE = "exchange",
  /** CalDAV. */
  CALDAV = "caldav",
  /** MobileMe. */
  MOBILEME = "mobileme",
  /** Subscribed. */
  SUBSCRIBED = "subscribed",
  /** Birthdays. */
  BIRTHDAYS = "birthdays",
}

/** An attendee's role. */
export enum AttendeeRole {
  /** Not known. */
  UNKNOWN = "unknown",
  /** Required. */
  REQUIRED = "required",
  /** Optional. */
  OPTIONAL = "optional",
  /** The chair. */
  CHAIR = "chair",
  /** A non-participant. */
  NON_PARTICIPANT = "nonParticipant",
  /** An attendee (Android). */
  ATTENDEE = "attendee",
  /** The organizer (Android). */
  ORGANIZER = "organizer",
  /** A performer (Android). */
  PERFORMER = "performer",
  /** A speaker (Android). */
  SPEAKER = "speaker",
  /** None (Android). */
  NONE = "none",
}

/** An attendee's response. */
export enum AttendeeStatus {
  /** Not known. */
  UNKNOWN = "unknown",
  /** Pending. */
  PENDING = "pending",
  /** Accepted. */
  ACCEPTED = "accepted",
  /** Declined. */
  DECLINED = "declined",
  /** Tentative. */
  TENTATIVE = "tentative",
  /** Delegated. */
  DELEGATED = "delegated",
  /** Completed. */
  COMPLETED = "completed",
  /** In process. */
  IN_PROCESS = "inProcess",
  /** Invited (Android). */
  INVITED = "invited",
  /** None (Android). */
  NONE = "none",
}

/** An attendee's kind. */
export enum AttendeeType {
  /** Not known. */
  UNKNOWN = "unknown",
  /** A person. */
  PERSON = "person",
  /** A room. */
  ROOM = "room",
  /** A group. */
  GROUP = "group",
  /** A resource. */
  RESOURCE = "resource",
  /** Optional (Android). */
  OPTIONAL = "optional",
  /** Required (Android). */
  REQUIRED = "required",
  /** None (Android). */
  NONE = "none",
}

/** How an alarm alerts (Android). */
export enum AlarmMethod {
  /** An alarm. */
  ALARM = "alarm",
  /** An alert. */
  ALERT = "alert",
  /** An email. */
  EMAIL = "email",
  /** An SMS. */
  SMS = "sms",
  /** The default. */
  DEFAULT = "default",
}

/** An event's visibility (Android). */
export enum EventAccessLevel {
  /** Confidential. */
  CONFIDENTIAL = "confidential",
  /** Private. */
  PRIVATE = "private",
  /** Public. */
  PUBLIC = "public",
  /** The default. */
  DEFAULT = "default",
}

/** The current user's access to a calendar (Android). */
export enum CalendarAccessLevel {
  /** Contributor. */
  CONTRIBUTOR = "contributor",
  /** Editor. */
  EDITOR = "editor",
  /** Free/busy only. */
  FREEBUSY = "freebusy",
  /** Override. */
  OVERRIDE = "override",
  /** Owner. */
  OWNER = "owner",
  /** Read. */
  READ = "read",
  /** Respond. */
  RESPOND = "respond",
  /** Root. */
  ROOT = "root",
  /** None. */
  NONE = "none",
}

/** A reminder's completion state. */
export enum ReminderStatus {
  /** Completed. */
  COMPLETED = "completed",
  /** Not completed. */
  INCOMPLETE = "incomplete",
}

/** A weekday, as Expo numbers it (Sunday is 1). */
export enum DayOfTheWeek {
  /** Sunday. */
  Sunday = 1,
  /** Monday. */
  Monday = 2,
  /** Tuesday. */
  Tuesday = 3,
  /** Wednesday. */
  Wednesday = 4,
  /** Thursday. */
  Thursday = 5,
  /** Friday. */
  Friday = 6,
  /** Saturday. */
  Saturday = 7,
}

/** A month (January is 1). */
export enum MonthOfTheYear {
  /** January. */
  January = 1,
  /** February. */
  February = 2,
  /** March. */
  March = 3,
  /** April. */
  April = 4,
  /** May. */
  May = 5,
  /** June. */
  June = 6,
  /** July. */
  July = 7,
  /** August. */
  August = 8,
  /** September. */
  September = 9,
  /** October. */
  October = 10,
  /** November. */
  November = 11,
  /** December. */
  December = 12,
}

/** How a calendar dialog ended. */
export enum CalendarDialogResultActions {
  /** Dismissed (Android: always, as the outcome is not reported). */
  done = "done",
  /** Canceled. */
  canceled = "canceled",
  /** The event was deleted. */
  deleted = "deleted",
  /** The user responded to an invitation. */
  responded = "responded",
  /** The event was saved. */
  saved = "saved",
}

// ---- Types (Expo's legacy shapes) ------------------------------------------------------------

/** A calendar account. */
export interface Source {
  /** The id (iOS). */
  id?: string;
  /** The kind: a {@linkcode SourceType} on iOS, the account type on Android. */
  type: string | SourceType;
  /** The name. */
  name: string;
  /** Whether it is a local account (Android). */
  isLocalAccount?: boolean;
}

/** A calendar (or an iOS reminders list). */
export interface Calendar {
  /** The id. */
  id: string;
  /** The display title. */
  title: string;
  /** The source's id (iOS). */
  sourceId?: string;
  /** The account it belongs to. */
  source: Source;
  /** The kind (iOS). */
  type?: CalendarType;
  /** The colour (hex). */
  color: string;
  /** What it holds. */
  entityType?: EntityTypes;
  /** Whether events can be added, changed or removed. */
  allowsModifications: boolean;
  /** The availabilities its events can take (not reported here: empty). */
  allowedAvailabilities: Availability[];
  /** Whether it is the default calendar. */
  isPrimary?: boolean;
  /** The internal name (Android). */
  name?: string | null;
  /** The owner's account (Android). */
  ownerAccount?: string;
  /** The time zone (not reported here). */
  timeZone?: string;
  /** The alarm methods it allows (not reported here). */
  allowedReminders?: AlarmMethod[];
  /** The attendee types it allows (not reported here). */
  allowedAttendeeTypes?: AttendeeType[];
  /** Whether its events are shown (Android). */
  isVisible?: boolean;
  /** Whether it is synced (not reported here). */
  isSynced?: boolean;
  /** The current user's access (not reported here). */
  accessLevel?: CalendarAccessLevel;
}

/** Where an alarm triggers. */
export interface AlarmLocation {
  /** The place's title. */
  title?: string;
  /** `"enter"`, `"leave"` or `"none"`. */
  proximity?: string;
  /** The radius, in meters. */
  radius?: number;
  /** The coordinates. */
  coords?: {
    /** The latitude. */
    latitude?: number;
    /** The longitude. */
    longitude?: number;
  };
}

/** An alarm. Only `relativeOffset` (minutes from the start) reaches the plugin. */
export interface Alarm {
  /** An absolute time (ISO string). Not supported here. */
  absoluteDate?: string;
  /** Minutes from the start (negative: before). */
  relativeOffset?: number;
  /** A location trigger. Not supported here. */
  structuredLocation?: AlarmLocation;
  /** How it alerts (Android). */
  method?: AlarmMethod;
}

/** A weekday of a recurrence. */
export interface DaysOfTheWeek {
  /** The day. */
  dayOfTheWeek: DayOfTheWeek;
  /** The week of the month (iOS). Not supported here. */
  weekNumber?: number;
}

/** How an event or reminder repeats. */
export interface RecurrenceRule {
  /** How often. */
  frequency: Frequency;
  /** Every how many periods (default 1). */
  interval?: number;
  /** When it stops. */
  endDate?: string | Date;
  /** How many times it occurs. */
  occurrence?: number;
  /** On which weekdays. */
  daysOfTheWeek?: DaysOfTheWeek[];
  /** On which days of the month. */
  daysOfTheMonth?: number[];
  /** In which months. */
  monthsOfTheYear?: MonthOfTheYear[];
  /** In which weeks of the year. */
  weeksOfTheYear?: number[];
  /** On which days of the year. */
  daysOfTheYear?: number[];
  /** Set positions (iOS). Not supported here. */
  setPositions?: number[];
}

/** Which occurrence(s) of a recurring event a call means. */
export interface RecurringEventOptions {
  /** This and the following occurrences. */
  futureEvents?: boolean;
  /** The start of the occurrence. */
  instanceStartDate?: string | Date;
}

/** An event's organizer. */
export interface Organizer {
  /** Whether it is the current user. */
  isCurrentUser: boolean;
  /** The name. */
  name?: string;
  /** The role. */
  role: string;
  /** The status. */
  status: string;
  /** The kind. */
  type: string;
  /** The URL. */
  url?: string;
}

/** An event. */
export interface Event {
  /** The id. */
  id: string;
  /** The calendar's id. */
  calendarId: string;
  /** The title. */
  title: string;
  /** The location. */
  location: string | null;
  /** When it was created. */
  creationDate?: string | Date;
  /** When it was last changed. */
  lastModifiedDate?: string | Date;
  /** The time zone. */
  timeZone: string;
  /** The end's time zone (Android). */
  endTimeZone?: string;
  /** The URL. */
  url?: string;
  /** The notes. */
  notes: string;
  /** The alarms. */
  alarms: Alarm[];
  /** The recurrence (always `null` when read here: the plugin does not report it). */
  recurrenceRule: RecurrenceRule | null;
  /** The start. */
  startDate: string | Date;
  /** The end. */
  endDate: string | Date;
  /** The occurrence's original start (iOS). */
  originalStartDate?: string | Date;
  /** Whether the occurrence was changed from its series (iOS). */
  isDetached?: boolean;
  /** Whether it lasts all day. */
  allDay: boolean;
  /** Free/busy. */
  availability: Availability;
  /** The status. */
  status: EventStatus;
  /** The organizer. */
  organizer?: Organizer;
  /** The organizer's email. */
  organizerEmail?: string;
  /** Visibility (Android). */
  accessLevel?: EventAccessLevel;
  /** Whether guests can change it (Android). */
  guestsCanModify?: boolean;
  /** Whether guests can invite others (Android). */
  guestsCanInviteOthers?: boolean;
  /** Whether guests can see each other (Android). */
  guestsCanSeeGuests?: boolean;
  /** The series' id, for an occurrence of a recurring event. */
  originalId?: string;
  /** The occurrence's id (Android). */
  instanceId?: string;
}

/** A reminder (iOS). */
export interface Reminder {
  /** The id. */
  id?: string;
  /** The reminders list's id. */
  calendarId?: string;
  /** The title. */
  title?: string;
  /** The location. */
  location?: string;
  /** When it was created. */
  creationDate?: string | Date;
  /** When it was last changed. */
  lastModifiedDate?: string | Date;
  /** The time zone. */
  timeZone?: string;
  /** The URL. */
  url?: string;
  /** The notes. */
  notes?: string;
  /** The alarms. */
  alarms?: Alarm[];
  /** The recurrence. */
  recurrenceRule?: RecurrenceRule | null;
  /** The start. */
  startDate?: string | Date;
  /** When it is due. */
  dueDate?: string | Date;
  /** Whether it lasts all day. */
  allDay?: boolean;
  /** Whether it is done. */
  completed?: boolean;
  /** When it was done. */
  completionDate?: string | Date;
}

/** An event attendee. */
export interface Attendee {
  /** The id. */
  id?: string;
  /** Whether it is the current user. */
  isCurrentUser?: boolean;
  /** The name. */
  name: string;
  /** The role. */
  role: AttendeeRole;
  /** The response. */
  status: AttendeeStatus;
  /** The kind. */
  type: AttendeeType;
  /** The URL. */
  url?: string;
  /** The email. */
  email?: string;
}

/** How an event dialog ended, and the event's id. */
export interface DialogEventResult {
  /** How it ended. */
  action:
    | CalendarDialogResultActions.done
    | CalendarDialogResultActions.saved
    | CalendarDialogResultActions.canceled
    | CalendarDialogResultActions.deleted;
  /** The event's id (`null` when not known). */
  id: string | null;
}

/** How an "open event" dialog ended. */
export interface OpenEventDialogResult {
  /** How it ended. */
  action:
    | CalendarDialogResultActions.done
    | CalendarDialogResultActions.canceled
    | CalendarDialogResultActions.deleted
    | CalendarDialogResultActions.responded;
}

/** How to present a dialog (Android). */
export interface PresentationOptions {
  /** Open it as a new task (Android). Ignored here. */
  startNewActivityTask?: boolean;
}

/** How to present an existing event. */
export interface OpenEventPresentationOptions extends PresentationOptions {
  /** Whether it can be edited. */
  allowsEditing?: boolean;
  /** Whether the calendar preview shows. */
  allowsCalendarPreview?: boolean;
}

/** Which event a dialog shows. */
export interface CalendarDialogParams {
  /** The event's id. */
  id: string;
  /** The occurrence's start. Not supported here. */
  instanceStartDate?: string | Date;
}

/** What {@linkcode ExpoCalendar.update} changes. */
export type ModifiableCalendarProperties = Pick<Calendar, "color" | "title">;

/** What {@linkcode ExpoCalendarEvent.update} changes. */
export type ModifiableEventProperties = Pick<
  Event,
  | "title"
  | "location"
  | "timeZone"
  | "url"
  | "notes"
  | "alarms"
  | "recurrenceRule"
  | "availability"
  | "startDate"
  | "endDate"
  | "allDay"
>;

/** What {@linkcode ExpoCalendarReminder.update} changes. */
export type ModifiableReminderProperties = Pick<
  Reminder,
  | "title"
  | "location"
  | "timeZone"
  | "url"
  | "notes"
  | "alarms"
  | "recurrenceRule"
  | "startDate"
  | "dueDate"
  | "completed"
  | "completionDate"
>;

/** The event {@linkcode ExpoCalendar.addEventWithForm} pre-fills. */
export interface AddEventWithFormOptions extends PresentationOptions {
  /** The title. */
  title?: string;
  /** The start. */
  startDate?: Date | string;
  /** The end. */
  endDate?: Date | string;
  /** Whether it lasts all day. */
  allDay?: boolean;
  /** The notes. */
  notes?: string;
  /** The location. */
  location?: string;
  /** The URL. */
  url?: string;
  /** The alarms. */
  alarms?: Alarm[];
  /** The recurrence. */
  recurrenceRule?: RecurrenceRule;
}

// ---- The plugin ------------------------------------------------------------------------------

/** `@capacitor/core`'s permission state. */
type PluginPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale";

/** The plugin's calendar (and reminders list). */
interface PluginCalendar {
  id: string;
  title: string | null;
  internalTitle: string | null;
  color: string | null;
  isImmutable: boolean | null;
  allowsContentModifications: boolean | null;
  type: number | null;
  source: { type: number; id: string; title: string } | null;
  visible: boolean | null;
  accountName: string | null;
  ownerAccount: string | null;
}

/** The plugin's event. */
interface PluginEvent {
  id: string;
  calendarId: string | null;
  title: string;
  location: string | null;
  description: string | null;
  url: string | null;
  timezone: string | null;
  startDate: number;
  endDate: number;
  isAllDay: boolean;
  alerts: number[];
  availability: number | null;
  status: string | null;
  organizer: string | null;
  creationDate: number | null;
  lastModifiedDate: number | null;
  isDetached: boolean | null;
  masterId: string | null;
}

/** The plugin's reminder. */
interface PluginReminder {
  id: string;
  title: string | null;
  listId: string | null;
  isCompleted: boolean;
  notes: string | null;
  location: string | null;
  url: string | null;
  startDate: number | null;
  dueDate: number | null;
  completionDate: number | null;
  recurrence: { frequency: string; interval: number; end?: number }[];
  alerts: number[];
}

/** The plugin's event recurrence. */
interface PluginRecurrence {
  frequency: string;
  interval?: number;
  end?: number;
  count?: number;
  byWeekDay?: number[];
  byMonthDay?: number[];
  byMonth?: number[];
  weeksOfTheYear?: number[];
  daysOfTheYear?: number[];
}

/** The event fields the plugin's create/modify calls take. */
interface PluginEventFields {
  title?: string;
  calendarId?: string;
  startDate?: number;
  endDate?: number;
  isAllDay?: boolean;
  location?: string;
  description?: string;
  url?: string;
  alerts?: number[];
  availability?: number;
  recurrence?: PluginRecurrence;
}

/** The reminder fields the plugin's create/modify calls take. */
interface PluginReminderFields {
  title?: string;
  listId?: string;
  notes?: string;
  location?: string;
  url?: string;
  startDate?: number;
  dueDate?: number;
  isCompleted?: boolean;
  completionDate?: number;
  alerts?: number[];
  recurrence?: { frequency: string; interval: number; end?: number };
}

/** The JS side of `@ebarooni/capacitor-calendar` (the calls used here). */
interface CalendarPlugin {
  checkAllPermissions(): Promise<{ result: Record<string, PluginPermission> }>;
  requestFullCalendarAccess(): Promise<{ result: PluginPermission }>;
  requestWriteOnlyCalendarAccess(): Promise<{ result: PluginPermission }>;
  requestFullRemindersAccess(): Promise<{ result: PluginPermission }>;
  listCalendars(): Promise<{ result: PluginCalendar[] }>;
  getDefaultCalendar(o?: object): Promise<{ result: PluginCalendar | null }>;
  selectCalendarsWithPrompt(o?: object): Promise<{ result: PluginCalendar[] }>;
  fetchAllCalendarSources(): Promise<{ result: { type: number; id: string; title: string }[] }>;
  createCalendar(o: object): Promise<{ id: string }>;
  modifyCalendar(o: object): Promise<void>;
  deleteCalendar(o: { id: string }): Promise<void>;
  listEventsInRange(o: { from: number; to: number }): Promise<{ result: PluginEvent[] }>;
  createEvent(o: PluginEventFields): Promise<{ id: string | null }>;
  modifyEvent(o: PluginEventFields & { id: string; span?: number }): Promise<void>;
  deleteEvent(o: { id: string; span?: number; instanceDate?: number }): Promise<void>;
  createEventWithPrompt(o: PluginEventFields): Promise<{ id: string | null }>;
  modifyEventWithPrompt(o: { id: string }): Promise<{ result: string | null }>;
  getRemindersLists(): Promise<{ result: PluginCalendar[] }>;
  createRemindersList(o: object): Promise<{ id: string }>;
  updateRemindersList(o: object): Promise<{ id: string }>;
  deleteRemindersList(o: { id: string }): Promise<void>;
  getRemindersFromLists(o: { listIds: string[] }): Promise<{ result: PluginReminder[] }>;
  getReminderById(o: { id: string }): Promise<{ result: PluginReminder | null }>;
  createReminder(o: PluginReminderFields & { title: string }): Promise<{ id: string }>;
  modifyReminder(o: PluginReminderFields & { id: string }): Promise<void>;
  deleteReminder(o: { id: string }): Promise<void>;
}

/** The plugin with `method`, or `undefined` off the shell / without it. */
function maybePlugin(method: keyof CalendarPlugin): CalendarPlugin | undefined {
  return nativePlugin<CalendarPlugin>("CapacitorCalendar", [method]);
}

/** The plugin with `method`, or the `ERR_UNAVAILABLE` for `name`. */
function plugin(name: string, method: keyof CalendarPlugin): CalendarPlugin {
  const found = maybePlugin(method);
  if (!found) throw unavailable(PKG, name, NEEDS_SHELL);
  return found;
}

/** The plugin for a reminders call: iOS only. */
function remindersPlugin(name: string, method: keyof CalendarPlugin): CalendarPlugin {
  const found = plugin(name, method);
  if (nativePlatform() !== "ios") throw unavailable(PKG, name, IOS_ONLY);
  return found;
}

/** A rejection with `name`'s unavailability. */
function reject<T>(name: string, why: string): Promise<T> {
  return Promise.reject(unavailable(PKG, name, why));
}

// ---- Mapping ---------------------------------------------------------------------------------

/** Milliseconds since the epoch of a date or ISO string. */
function ms(value: Date | string): number {
  return new Date(value).getTime();
}

/** `ms` for an optional value. */
function optMs(value: Date | string | null | undefined): number | undefined {
  return value === undefined || value === null ? undefined : ms(value);
}

/** An ISO string of a plugin timestamp, or `undefined`. */
function iso(value: number | null | undefined): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}

/** The plugin's `CalendarType` (0–4) as Expo's. */
const CALENDAR_TYPES = [
  CalendarType.LOCAL,
  CalendarType.CALDAV,
  CalendarType.EXCHANGE,
  CalendarType.SUBSCRIBED,
  CalendarType.BIRTHDAYS,
];
/** The plugin's `CalendarSourceType` (0–5) as Expo's. */
const SOURCE_TYPES = [
  SourceType.LOCAL,
  SourceType.EXCHANGE,
  SourceType.CALDAV,
  SourceType.MOBILEME,
  SourceType.SUBSCRIBED,
  SourceType.BIRTHDAYS,
];
/** The plugin's `EventAvailability` (-1–3) as Expo's, offset by one. */
const AVAILABILITIES = [
  Availability.NOT_SUPPORTED,
  Availability.BUSY,
  Availability.FREE,
  Availability.TENTATIVE,
  Availability.UNAVAILABLE,
];

/** A plugin calendar source as Expo's {@linkcode Source}. */
function toSource(source: { type: number; id: string; title: string }): Source {
  const type = SOURCE_TYPES[source.type] ?? SourceType.LOCAL;
  return { id: source.id, name: source.title, type, isLocalAccount: type === SourceType.LOCAL };
}

/** A plugin calendar as Expo's {@linkcode Calendar}. */
function toCalendar(cal: PluginCalendar, entityType: EntityTypes): Calendar {
  const source: Source = cal.source
    ? toSource(cal.source)
    : { name: cal.accountName ?? "", type: "unknown" };
  return {
    id: cal.id,
    title: cal.title ?? cal.internalTitle ?? "",
    sourceId: cal.source?.id,
    source,
    type: cal.type === null ? undefined : CALENDAR_TYPES[cal.type],
    color: cal.color ?? "",
    entityType,
    allowsModifications: cal.allowsContentModifications ?? cal.isImmutable === false,
    allowedAvailabilities: [],
    name: cal.internalTitle,
    ownerAccount: cal.ownerAccount ?? undefined,
    isVisible: cal.visible ?? undefined,
  };
}

/** A plugin event as Expo's {@linkcode Event}. */
function toEvent(ev: PluginEvent): Event {
  return {
    id: ev.id,
    calendarId: ev.calendarId ?? "",
    title: ev.title,
    location: ev.location,
    creationDate: iso(ev.creationDate),
    lastModifiedDate: iso(ev.lastModifiedDate),
    timeZone: ev.timezone ?? "",
    url: ev.url ?? undefined,
    notes: ev.description ?? "",
    alarms: ev.alerts.map((relativeOffset) => ({ relativeOffset })),
    recurrenceRule: null,
    startDate: iso(ev.startDate)!,
    endDate: iso(ev.endDate)!,
    isDetached: ev.isDetached ?? undefined,
    allDay: ev.isAllDay,
    availability: AVAILABILITIES[(ev.availability ?? -1) + 1] ?? Availability.NOT_SUPPORTED,
    status: (ev.status as EventStatus | null) ?? EventStatus.NONE,
    organizerEmail: ev.organizer ?? undefined,
    originalId: ev.masterId && ev.masterId !== ev.id ? ev.masterId : undefined,
  };
}

/** A plugin reminder as Expo's {@linkcode Reminder}. */
function toReminder(r: PluginReminder): Reminder {
  const rule = r.recurrence[0];
  return {
    id: r.id,
    calendarId: r.listId ?? undefined,
    title: r.title ?? undefined,
    location: r.location ?? undefined,
    url: r.url ?? undefined,
    notes: r.notes ?? undefined,
    alarms: r.alerts.map((relativeOffset) => ({ relativeOffset })),
    recurrenceRule: rule
      ? { frequency: rule.frequency as Frequency, interval: rule.interval, endDate: iso(rule.end) }
      : null,
    startDate: iso(r.startDate),
    dueDate: iso(r.dueDate),
    completed: r.isCompleted,
    completionDate: iso(r.completionDate),
  };
}

/** Expo's alarms as the plugin's alerts (minutes from the start); others are dropped. */
function toAlerts(alarms: Alarm[] | undefined): number[] | undefined {
  return alarms?.flatMap((a) => typeof a.relativeOffset === "number" ? [a.relativeOffset] : []);
}

/** Expo's recurrence as the plugin's (weekdays renumbered: Expo's Sunday 1 → plugin's 7). */
function toRecurrence(rule: RecurrenceRule | null | undefined): PluginRecurrence | undefined {
  if (!rule) return undefined;
  return defined({
    frequency: rule.frequency,
    interval: rule.interval,
    end: optMs(rule.endDate),
    count: rule.occurrence,
    byWeekDay: rule.daysOfTheWeek?.map((d) => d.dayOfTheWeek === 1 ? 7 : d.dayOfTheWeek - 1),
    byMonthDay: rule.daysOfTheMonth,
    byMonth: rule.monthsOfTheYear,
    weeksOfTheYear: rule.weeksOfTheYear,
    daysOfTheYear: rule.daysOfTheYear,
  });
}

/** The defined entries of `fields` (the plugin reads a present `undefined` as a value). */
function defined<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as T;
}

/** Expo event details as the plugin's event fields. */
function toEventFields(details: Partial<Event>): PluginEventFields {
  const availability = details.availability === undefined
    ? undefined
    : AVAILABILITIES.indexOf(details.availability) - 1;
  return defined({
    title: details.title,
    startDate: optMs(details.startDate),
    endDate: optMs(details.endDate),
    isAllDay: details.allDay,
    location: details.location ?? undefined,
    description: details.notes,
    url: details.url,
    alerts: toAlerts(details.alarms),
    availability: availability !== undefined && availability >= -1 ? availability : undefined,
    recurrence: toRecurrence(details.recurrenceRule),
  });
}

/** Expo reminder details as the plugin's reminder fields. */
function toReminderFields(details: Reminder): PluginReminderFields {
  const rule = details.recurrenceRule;
  return defined({
    title: details.title,
    notes: details.notes,
    location: details.location,
    url: details.url,
    startDate: optMs(details.startDate),
    dueDate: optMs(details.dueDate),
    isCompleted: details.completed,
    completionDate: optMs(details.completionDate),
    alerts: toAlerts(details.alarms),
    recurrence: rule
      ? { frequency: rule.frequency, interval: rule.interval ?? 1, end: optMs(rule.endDate) }
      : undefined,
  });
}

/** The plugin's span for `options`: 1 (this and future) or 0 (this one). */
function span(options: RecurringEventOptions | undefined): number {
  return options?.futureEvents === true ? 1 : 0;
}

/** Whether `id` is an iOS reminders list (they share Expo's calendar calls). */
async function isRemindersList(id: string): Promise<boolean> {
  if (nativePlatform() !== "ios") return false;
  const p = maybePlugin("getRemindersLists");
  if (!p) return false;
  const lists = await p.getRemindersLists().catch(() => ({ result: [] }));
  return lists.result.some((l) => l.id === id);
}

// ---- Permissions -----------------------------------------------------------------------------

/** The combined Expo answer of the plugin's states for `scopes`. */
function toResponse(states: PluginPermission[]): PermissionResponse {
  if (states.every((s) => s === "granted")) return permissionResponse(PermissionStatus.GRANTED);
  if (states.some((s) => s === "denied")) {
    return { ...permissionResponse(PermissionStatus.DENIED), canAskAgain: false };
  }
  return permissionResponse(PermissionStatus.UNDETERMINED);
}

/** The permission for `scopes`, or Expo's web answer without the plugin. */
async function checkScopes(scopes: string[]): Promise<PermissionResponse> {
  const p = maybePlugin("checkAllPermissions");
  if (!p) return permissionResponse(PermissionStatus.UNDETERMINED);
  const { result } = await p.checkAllPermissions();
  return toResponse(scopes.map((s) => result[s] ?? "prompt"));
}

/** Ask through `method`, or Expo's web answer without the plugin. */
async function ask(
  method: "requestFullCalendarAccess" | "requestWriteOnlyCalendarAccess",
): Promise<PermissionResponse> {
  const p = maybePlugin(method);
  if (!p) return permissionResponse(PermissionStatus.UNDETERMINED);
  return toResponse([(await p[method]()).result]);
}

/**
 * The calendar permission, without prompting (the new API).
 *
 * @param writeOnly Read the iOS 17 write-only access instead of full access.
 * @returns The answer; `undetermined` off the shell, as Expo's web build.
 */
export function getCalendarPermissions(writeOnly?: boolean): Promise<PermissionResponse> {
  return checkScopes(writeOnly ? ["writeCalendar"] : ["readCalendar", "writeCalendar"]);
}

/**
 * Ask for calendar access (the new API).
 *
 * @param writeOnly Ask for write-only access (iOS 17+) instead of full access.
 * @returns The answer; `undetermined` off the shell, as Expo's web build.
 */
export function requestCalendarPermissions(writeOnly?: boolean): Promise<PermissionResponse> {
  return ask(writeOnly ? "requestWriteOnlyCalendarAccess" : "requestFullCalendarAccess");
}

/**
 * The reminders permission (iOS), without prompting.
 *
 * @returns The answer; `undetermined` off the shell and on Android.
 */
export function getRemindersPermissions(): Promise<PermissionResponse> {
  return checkScopes(["readReminders", "writeReminders"]);
}

/**
 * Ask for reminders access (iOS).
 *
 * @returns The answer; `undetermined` off the shell.
 * @throws `ERR_UNAVAILABLE` on Android (no reminders there).
 */
export async function requestRemindersPermissions(): Promise<PermissionResponse> {
  const p = maybePlugin("requestFullRemindersAccess");
  if (!p) return permissionResponse(PermissionStatus.UNDETERMINED);
  if (nativePlatform() !== "ios") {
    throw unavailable(PKG, "requestRemindersPermissions", IOS_ONLY);
  }
  return toResponse([(await p.requestFullRemindersAccess()).result]);
}

/** Hook form of the calendar permission: `[response, request, get]`. */
export const useCalendarPermissions: (
  options?: PermissionHookOptions<{ writeOnly?: boolean }>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = /* @__PURE__ */ createPermissionHook<PermissionResponse, { writeOnly?: boolean }>({
  getMethod: (o) => getCalendarPermissions(o?.writeOnly),
  requestMethod: (o) => requestCalendarPermissions(o?.writeOnly),
});

/** The reminders permission hook. */
const remindersHook = /* @__PURE__ */ createPermissionHook<PermissionResponse, object>({
  getMethod: getRemindersPermissions,
  requestMethod: requestRemindersPermissions,
});

/**
 * Hook form of the reminders permission (iOS): `[response, request, get]`.
 *
 * @param options Whether to read (default) or request on mount.
 * @returns The response (null until read), a request function and a get function.
 */
export function useRemindersPermissions(
  options?: PermissionHookOptions<object>,
): [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] {
  return remindersHook(options);
}

/**
 * The calendar permission, without prompting (legacy).
 *
 * @returns See {@linkcode getCalendarPermissions}.
 */
export function getCalendarPermissionsAsync(): Promise<PermissionResponse> {
  return getCalendarPermissions();
}

/**
 * Ask for full calendar access (legacy).
 *
 * @returns See {@linkcode requestCalendarPermissions}.
 */
export function requestCalendarPermissionsAsync(): Promise<PermissionResponse> {
  return requestCalendarPermissions();
}

/**
 * Ask for full calendar access (legacy, deprecated in Expo).
 *
 * @returns See {@linkcode requestCalendarPermissions}.
 */
export function requestPermissionsAsync(): Promise<PermissionResponse> {
  return requestCalendarPermissions();
}

/**
 * The reminders permission (legacy).
 *
 * @returns See {@linkcode getRemindersPermissions}.
 */
export function getRemindersPermissionsAsync(): Promise<PermissionResponse> {
  return getRemindersPermissions();
}

/**
 * Ask for reminders access (legacy).
 *
 * @returns See {@linkcode requestRemindersPermissions}.
 */
export function requestRemindersPermissionsAsync(): Promise<PermissionResponse> {
  return requestRemindersPermissions();
}

// ---- Legacy API: calendars and sources -------------------------------------------------------

/**
 * Whether the calendar API works here: the shell with the plugin installed.
 *
 * @returns `true` only there.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(maybePlugin("listCalendars") !== undefined);
}

/**
 * The calendars. On iOS, `entityType` picks event calendars or reminders lists (both when
 * omitted; reminders lists only when reminders access allows reading them). Android ignores
 * it, as Expo does.
 *
 * @param entityType `"event"` or `"reminder"` (iOS).
 * @returns The calendars.
 */
export async function getCalendarsAsync(entityType?: string): Promise<Calendar[]> {
  const p = plugin("getCalendarsAsync", "listCalendars");
  if (nativePlatform() === "ios" && entityType === EntityTypes.REMINDER) {
    const { result } = await remindersPlugin("getCalendarsAsync", "getRemindersLists")
      .getRemindersLists();
    return result.map((c) => toCalendar(c, EntityTypes.REMINDER));
  }
  const events = (await p.listCalendars()).result.map((c) => toCalendar(c, EntityTypes.EVENT));
  if (nativePlatform() !== "ios" || entityType !== undefined) return events;
  const lists = await maybePlugin("getRemindersLists")?.getRemindersLists().catch(() => null);
  return [...events, ...(lists?.result ?? []).map((c) => toCalendar(c, EntityTypes.REMINDER))];
}

/**
 * The default calendar for new events (`isPrimary: true`).
 *
 * @returns The calendar.
 * @throws `E_CALENDAR_NOT_FOUND` when the system has none (or access is missing).
 */
export async function getDefaultCalendarAsync(): Promise<Calendar> {
  const { result } = await plugin("getDefaultCalendarAsync", "getDefaultCalendar")
    .getDefaultCalendar();
  if (!result) throw new CodedError("E_CALENDAR_NOT_FOUND", "There is no default calendar.");
  return { ...toCalendar(result, EntityTypes.EVENT), isPrimary: true };
}

/**
 * Create a calendar, or (iOS, `entityType: "reminder"`) a reminders list. On Android the
 * plugin needs `source.name` (the account) and `ownerAccount`.
 *
 * @param details `title`, `color`, `entityType`, `sourceId`, `source`, `ownerAccount`.
 * @returns The new id.
 */
export async function createCalendarAsync(details: Partial<Calendar> = {}): Promise<string> {
  const base = defined({ title: details.title ?? "", color: details.color || undefined });
  if (details.entityType === EntityTypes.REMINDER) {
    const p = remindersPlugin("createCalendarAsync", "createRemindersList");
    return (await p.createRemindersList(defined({ ...base, sourceId: details.sourceId }))).id;
  }
  const p = plugin("createCalendarAsync", "createCalendar");
  return (await p.createCalendar(defined({
    ...base,
    sourceId: details.sourceId,
    accountName: details.source?.name,
    ownerAccount: details.ownerAccount,
  }))).id;
}

/**
 * Change a calendar's (or reminders list's) title and colour; other fields are ignored.
 *
 * @param id The calendar.
 * @param details `title` and/or `color`.
 * @returns The id.
 */
export async function updateCalendarAsync(
  id: string,
  details: Partial<Calendar> = {},
): Promise<string> {
  const p = plugin("updateCalendarAsync", "modifyCalendar");
  const change = defined({ id, title: details.title, color: details.color || undefined });
  if (await isRemindersList(id)) await p.updateRemindersList(change);
  else await p.modifyCalendar(change);
  return id;
}

/**
 * Delete a calendar (or reminders list) and everything in it.
 *
 * @param id The calendar.
 */
export async function deleteCalendarAsync(id: string): Promise<void> {
  const p = plugin("deleteCalendarAsync", "deleteCalendar");
  if (await isRemindersList(id)) await p.deleteRemindersList({ id });
  else await p.deleteCalendar({ id });
}

/**
 * The calendar accounts.
 *
 * @returns The sources.
 */
export async function getSourcesAsync(): Promise<Source[]> {
  const p = plugin("getSourcesAsync", "fetchAllCalendarSources");
  return (await p.fetchAllCalendarSources()).result.map(toSource);
}

/**
 * One calendar account.
 *
 * @param id The source.
 * @returns The source.
 * @throws `E_SOURCE_NOT_FOUND` when there is none with that id.
 */
export async function getSourceAsync(id: string): Promise<Source> {
  const p = plugin("getSourceAsync", "fetchAllCalendarSources");
  const found = (await p.fetchAllCalendarSources()).result.find((s) => s.id === id);
  if (!found) throw new CodedError("E_SOURCE_NOT_FOUND", `There is no source with id ${id}.`);
  return toSource(found);
}

// ---- Legacy API: events ----------------------------------------------------------------------

/**
 * The events (occurrences) overlapping `[startDate, endDate]` in the given calendars (all
 * calendars when the list is empty).
 *
 * @param calendarIds The calendars.
 * @param startDate The range's start.
 * @param endDate The range's end.
 * @returns The events.
 */
export async function getEventsAsync(
  calendarIds: string[],
  startDate: Date | string,
  endDate: Date | string,
): Promise<Event[]> {
  const p = plugin("getEventsAsync", "listEventsInRange");
  const { result } = await p.listEventsInRange({ from: ms(startDate), to: ms(endDate) });
  const ids = new Set(calendarIds);
  return result
    .filter((ev) => ids.size === 0 || (ev.calendarId !== null && ids.has(ev.calendarId)))
    .map(toEvent);
}

/**
 * One event. The plugin cannot look an event up by id alone: pass the occurrence's start as
 * `recurringEventOptions.instanceStartDate` (the `startDate` a listing returned).
 *
 * @param id The event.
 * @param recurringEventOptions `instanceStartDate`, required here.
 * @returns The event.
 * @throws `ERR_UNAVAILABLE` without `instanceStartDate`; `E_EVENT_NOT_FOUND` when no event
 *   with that id starts then.
 */
export async function getEventAsync(
  id: string,
  recurringEventOptions?: RecurringEventOptions,
): Promise<Event> {
  const p = plugin("getEventAsync", "listEventsInRange");
  const start = recurringEventOptions?.instanceStartDate;
  if (start === undefined) {
    throw unavailable(
      PKG,
      "getEventAsync",
      "The plugin cannot look an event up by id alone; pass " +
        "recurringEventOptions.instanceStartDate (or use getEventsAsync).",
    );
  }
  const at = ms(start);
  const { result } = await p.listEventsInRange({ from: at, to: at + 1 });
  const found = result.find((ev) => ev.id === id);
  if (!found) throw new CodedError("E_EVENT_NOT_FOUND", `There is no event with id ${id}.`);
  return toEvent(found);
}

/**
 * Create an event. `timeZone`, attendees and absolute or location alarms are not passed on.
 *
 * @param calendarId The calendar.
 * @param eventData The event.
 * @returns The new id.
 */
export async function createEventAsync(
  calendarId: string,
  eventData: Omit<Partial<Event>, "id" | "organizer"> = {},
): Promise<string> {
  const p = plugin("createEventAsync", "createEvent");
  const { id } = await p.createEvent({ title: "", ...toEventFields(eventData), calendarId });
  if (!id) throw new CodedError("E_EVENT_NOT_SAVED", "The event was not saved.");
  return id;
}

/**
 * Change an event (with `futureEvents`, this and the following occurrences).
 *
 * @param id The event.
 * @param details The fields to change.
 * @param recurringEventOptions `futureEvents`; `instanceStartDate` is not supported.
 * @returns The id.
 * @throws `ERR_UNAVAILABLE` for `instanceStartDate` (the plugin cannot pick an occurrence).
 */
export async function updateEventAsync(
  id: string,
  details: Omit<Partial<Event>, "id"> = {},
  recurringEventOptions?: RecurringEventOptions,
): Promise<string> {
  const p = plugin("updateEventAsync", "modifyEvent");
  if (recurringEventOptions?.instanceStartDate !== undefined) {
    throw unavailable(PKG, "updateEventAsync", "The plugin cannot change a single occurrence.");
  }
  await p.modifyEvent({ ...toEventFields(details), id, span: span(recurringEventOptions) });
  return id;
}

/**
 * Delete an event, one occurrence (`instanceStartDate`) or this and the following ones
 * (`futureEvents`).
 *
 * @param id The event.
 * @param recurringEventOptions Which occurrences.
 */
export async function deleteEventAsync(
  id: string,
  recurringEventOptions?: RecurringEventOptions,
): Promise<void> {
  const p = plugin("deleteEventAsync", "deleteEvent");
  await p.deleteEvent(defined({
    id,
    span: span(recurringEventOptions),
    instanceDate: optMs(recurringEventOptions?.instanceStartDate),
  }));
}

/**
 * Open the system's new-event editor, pre-filled. On iOS the result says whether it was
 * saved (with the new id) or canceled; Android does not report it (`done`, `id: null`).
 *
 * @param eventData The pre-filled event (`calendarId` picks the calendar).
 * @param _presentationOptions Ignored.
 * @returns The outcome.
 */
export async function createEventInCalendarAsync(
  eventData: Omit<Partial<Event>, "id"> = {},
  _presentationOptions?: PresentationOptions,
): Promise<DialogEventResult> {
  const p = plugin("createEventInCalendarAsync", "createEventWithPrompt");
  const { id } = await p.createEventWithPrompt(
    defined({ ...toEventFields(eventData), calendarId: eventData.calendarId || undefined }),
  );
  if (nativePlatform() !== "ios") return { action: CalendarDialogResultActions.done, id: null };
  return id
    ? { action: CalendarDialogResultActions.saved, id }
    : { action: CalendarDialogResultActions.canceled, id: null };
}

/**
 * Open the system's event editor on an event. Android does not report the outcome (`done`).
 *
 * @param params The event (`instanceStartDate` is not supported).
 * @param _presentationOptions Ignored.
 * @returns The outcome.
 */
export async function editEventInCalendarAsync(
  params: CalendarDialogParams,
  _presentationOptions?: PresentationOptions,
): Promise<DialogEventResult> {
  const p = plugin("editEventInCalendarAsync", "modifyEventWithPrompt");
  if (params.instanceStartDate !== undefined) {
    throw unavailable(PKG, "editEventInCalendarAsync", "The plugin cannot open one occurrence.");
  }
  const { result } = await p.modifyEventWithPrompt({ id: params.id });
  switch (result) {
    case "saved":
      return { action: CalendarDialogResultActions.saved, id: params.id };
    case "deleted":
      return { action: CalendarDialogResultActions.deleted, id: null };
    case "canceled":
      return { action: CalendarDialogResultActions.canceled, id: params.id };
    default:
      return { action: CalendarDialogResultActions.done, id: params.id };
  }
}

/**
 * Show an event in the calendar app. The plugin has no such dialog.
 *
 * @param _params The event.
 * @param _presentationOptions The presentation.
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function openEventInCalendarAsync(
  _params: CalendarDialogParams,
  _presentationOptions?: OpenEventPresentationOptions,
): Promise<OpenEventDialogResult> {
  return reject("openEventInCalendarAsync", "The plugin cannot show an event.");
}

/**
 * Open an event in the Android calendar app. The plugin has no such call.
 *
 * @param _id The event.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function openEventInCalendar(_id: string): void {
  throw unavailable(PKG, "openEventInCalendar", "The plugin cannot show an event.");
}

/** The rejection every attendee call answers with. */
function noAttendees<T>(name: string): Promise<T> {
  return reject(name, "The plugin does not read or edit attendees.");
}

/**
 * An event's attendees. The plugin does not read them by event id.
 *
 * @param _id The event.
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function getAttendeesForEventAsync(_id: string): Promise<Attendee[]> {
  return noAttendees("getAttendeesForEventAsync");
}

/**
 * Add an attendee. Not supported by the plugin.
 *
 * @param _eventId The event.
 * @param _details The attendee.
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function createAttendeeAsync(_eventId: string, _details: Attendee): Promise<string> {
  return noAttendees("createAttendeeAsync");
}

/**
 * Change an attendee. Not supported by the plugin.
 *
 * @param _id The attendee.
 * @param _details The fields.
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function updateAttendeeAsync(_id: string, _details?: Partial<Attendee>): Promise<string> {
  return noAttendees("updateAttendeeAsync");
}

/**
 * Remove an attendee. Not supported by the plugin.
 *
 * @param _id The attendee.
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function deleteAttendeeAsync(_id: string): Promise<void> {
  return noAttendees("deleteAttendeeAsync");
}

// ---- Legacy API: reminders (iOS) -------------------------------------------------------------

/** Whether `value` (ms) falls in `[from, to]`, either bound optional. */
function inRange(value: number | null, from?: number, to?: number): boolean {
  if (from === undefined && to === undefined) return true;
  if (value === null) return false;
  return (from === undefined || value >= from) && (to === undefined || value <= to);
}

/**
 * The reminders in the given lists (all lists when empty), by status; a date range filters
 * on the due date (on the completion date for `completed`).
 *
 * @param calendarIds The reminders lists.
 * @param status `completed`, `incomplete`, or null for both.
 * @param startDate The range's start.
 * @param endDate The range's end.
 * @returns The reminders.
 */
export async function getRemindersAsync(
  calendarIds: (string | null)[],
  status: ReminderStatus | null,
  startDate?: Date | string | null,
  endDate?: Date | string | null,
): Promise<Reminder[]> {
  const p = remindersPlugin("getRemindersAsync", "getRemindersFromLists");
  let listIds = calendarIds.filter((id): id is string => typeof id === "string");
  if (listIds.length === 0) listIds = (await p.getRemindersLists()).result.map((l) => l.id);
  const { result } = await p.getRemindersFromLists({ listIds });
  const from = optMs(startDate);
  const to = optMs(endDate);
  return result
    .filter((r) =>
      status === ReminderStatus.COMPLETED
        ? r.isCompleted && inRange(r.completionDate, from, to)
        : (status === null || status === undefined || !r.isCompleted) &&
          inRange(r.dueDate, from, to)
    )
    .map(toReminder);
}

/**
 * One reminder.
 *
 * @param id The reminder.
 * @returns The reminder.
 * @throws `E_REMINDER_NOT_FOUND` when there is none with that id.
 */
export async function getReminderAsync(id: string): Promise<Reminder> {
  const p = remindersPlugin("getReminderAsync", "getReminderById");
  const { result } = await p.getReminderById({ id });
  if (!result) throw new CodedError("E_REMINDER_NOT_FOUND", `There is no reminder with id ${id}.`);
  return toReminder(result);
}

/**
 * Create a reminder.
 *
 * @param calendarId The reminders list (null: the default list).
 * @param reminder The reminder.
 * @returns The new id.
 */
export async function createReminderAsync(
  calendarId: string | null,
  reminder: Reminder = {},
): Promise<string> {
  const p = remindersPlugin("createReminderAsync", "createReminder");
  const fields = toReminderFields(reminder);
  return (await p.createReminder(
    defined({ ...fields, title: fields.title ?? "", listId: calendarId ?? undefined }),
  )).id;
}

/**
 * Change a reminder.
 *
 * @param id The reminder.
 * @param details The fields to change.
 * @returns The id.
 */
export async function updateReminderAsync(id: string, details: Reminder = {}): Promise<string> {
  const p = remindersPlugin("updateReminderAsync", "modifyReminder");
  await p.modifyReminder({ ...toReminderFields(details), id });
  return id;
}

/**
 * Delete a reminder.
 *
 * @param id The reminder.
 */
export async function deleteReminderAsync(id: string): Promise<void> {
  await remindersPlugin("deleteReminderAsync", "deleteReminder").deleteReminder({ id });
}

// ---- The object API --------------------------------------------------------------------------

/** An event, with methods (the new API). */
export class ExpoCalendarEvent {
  /** The id. */
  id: string;
  /** The calendar's id. */
  calendarId = "";
  /** The title. */
  title = "";
  /** The location. */
  location: string | null = null;
  /** When it was created. */
  creationDate?: string | Date;
  /** When it was last changed. */
  lastModifiedDate?: string | Date;
  /** The time zone. */
  timeZone = "";
  /** The URL. */
  url?: string;
  /** The notes. */
  notes = "";
  /** The alarms. */
  alarms: Alarm[] = [];
  /** The recurrence (`null` when read: the plugin does not report it). */
  recurrenceRule: RecurrenceRule | null = null;
  /** The start. */
  startDate: string | Date = "";
  /** The end. */
  endDate: string | Date = "";
  /** Whether the occurrence was changed from its series (iOS). */
  isDetached?: boolean;
  /** Whether it lasts all day. */
  allDay = false;
  /** Free/busy. */
  availability: Availability = Availability.NOT_SUPPORTED;
  /** The status. */
  status: EventStatus = EventStatus.NONE;
  /** The organizer's email. */
  organizerEmail?: string;
  /** The series' id, for an occurrence of a recurring event. */
  originalId?: string;

  /**
   * An event object for `id` (fields empty; {@linkcode getCalendars} and
   * {@linkcode ExpoCalendar.listEvents} return filled ones).
   *
   * @param id The event.
   */
  constructor(id: string) {
    this.id = id;
  }

  /**
   * Open the system event editor on it.
   *
   * @param params Ignored here (`instanceStartDate` is not supported).
   * @returns The outcome.
   */
  editInCalendar(params?: PresentationOptions): Promise<DialogEventResult> {
    return editEventInCalendarAsync({ id: this.id }, params);
  }

  /**
   * Change it; the object takes the new values.
   *
   * @param details The fields to change.
   */
  async update(details: Partial<ModifiableEventProperties>): Promise<void> {
    await updateEventAsync(this.id, details);
    Object.assign(this, details);
  }

  /** Delete it. */
  async delete(): Promise<void> {
    await deleteEventAsync(this.id);
  }
}

/** A reminder, with methods (the new API, iOS). */
export class ExpoCalendarReminder {
  /** The id. */
  id?: string;
  /** The reminders list's id. */
  calendarId?: string;
  /** The title. */
  title?: string;
  /** The location. */
  location?: string;
  /** The URL. */
  url?: string;
  /** The notes. */
  notes?: string;
  /** The alarms. */
  alarms?: Alarm[];
  /** The recurrence. */
  recurrenceRule?: RecurrenceRule | null;
  /** The start. */
  startDate?: string | Date;
  /** When it is due. */
  dueDate?: string | Date;
  /** Whether it is done. */
  completed?: boolean;
  /** When it was done. */
  completionDate?: string | Date;

  /**
   * Change it; the object takes the new values.
   *
   * @param details The fields to change.
   */
  async update(details: Partial<ModifiableReminderProperties>): Promise<void> {
    await updateReminderAsync(this.id ?? "", details);
    Object.assign(this, details);
  }

  /** Delete it. */
  async delete(): Promise<void> {
    await deleteReminderAsync(this.id ?? "");
  }

  /**
   * Read one reminder.
   *
   * @param reminderId The reminder.
   * @returns The reminder.
   */
  static async get(reminderId: string): Promise<ExpoCalendarReminder> {
    return Object.assign(new ExpoCalendarReminder(), await getReminderAsync(reminderId));
  }
}

/** An event object filled from `event`. */
function eventObject(event: Event): ExpoCalendarEvent {
  return Object.assign(new ExpoCalendarEvent(event.id), event);
}

/** A calendar, with methods (the new API). */
export class ExpoCalendar {
  /** The id. */
  id: string;
  /** The display title. */
  title = "";
  /** The source's id (iOS). */
  sourceId?: string;
  /** The account it belongs to. */
  source: Source = { name: "", type: "unknown" };
  /** The kind (iOS). */
  type?: CalendarType;
  /** The colour (hex). */
  color?: string;
  /** What it holds. */
  entityType?: EntityTypes;
  /** Whether events can be added, changed or removed. */
  allowsModifications = false;
  /** The availabilities its events can take (not reported here: empty). */
  allowedAvailabilities: Availability[] = [];
  /** Whether it is the default calendar. */
  isPrimary?: boolean;
  /** The internal name (Android). */
  name?: string | null;
  /** The owner's account (Android). */
  ownerAccount?: string;
  /** Whether its events are shown (Android). */
  isVisible?: boolean;

  /**
   * A calendar object for `id` (fields empty; {@linkcode getCalendars} and
   * {@linkcode ExpoCalendar.get} return filled ones).
   *
   * @param id The calendar.
   */
  constructor(id: string) {
    this.id = id;
  }

  /**
   * Its events overlapping `[startDate, endDate]`.
   *
   * @param startDate The range's start.
   * @param endDate The range's end.
   * @returns The events.
   */
  async listEvents(startDate: Date | string, endDate: Date | string): Promise<ExpoCalendarEvent[]> {
    return (await getEventsAsync([this.id], startDate, endDate)).map(eventObject);
  }

  /**
   * Its reminders (iOS reminders lists), by status and due-date range.
   *
   * @param startDate The range's start.
   * @param endDate The range's end.
   * @param status `completed`, `incomplete`, or null for both.
   * @returns The reminders.
   */
  async listReminders(
    startDate?: Date | string | null,
    endDate?: Date | string | null,
    status?: ReminderStatus | null,
  ): Promise<ExpoCalendarReminder[]> {
    const reminders = await getRemindersAsync([this.id], status ?? null, startDate, endDate);
    return reminders.map((r) => Object.assign(new ExpoCalendarReminder(), r));
  }

  /**
   * Create an event in it.
   *
   * @param eventData The event.
   * @returns The new event.
   */
  async createEvent(
    eventData: Omit<Partial<Event>, "id" | "organizer">,
  ): Promise<ExpoCalendarEvent> {
    const id = await createEventAsync(this.id, eventData);
    return Object.assign(new ExpoCalendarEvent(id), eventData, { id, calendarId: this.id });
  }

  /**
   * Create a reminder in it (an iOS reminders list).
   *
   * @param reminderData The reminder.
   * @returns The new reminder.
   */
  async createReminder(
    reminderData: Omit<Reminder, "id" | "calendarId">,
  ): Promise<ExpoCalendarReminder> {
    const id = await createReminderAsync(this.id, reminderData);
    return Object.assign(new ExpoCalendarReminder(), reminderData, { id, calendarId: this.id });
  }

  /**
   * Open the system new-event editor in it, pre-filled.
   *
   * @param options The pre-filled event.
   * @returns The outcome (see {@linkcode createEventInCalendarAsync}).
   */
  addEventWithForm(options: AddEventWithFormOptions = {}): Promise<DialogEventResult> {
    return createEventInCalendarAsync({ ...options, calendarId: this.id });
  }

  /**
   * Change its title and/or colour; the object takes the new values.
   *
   * @param details The fields to change.
   */
  async update(details: Partial<ModifiableCalendarProperties>): Promise<void> {
    await updateCalendarAsync(this.id, details);
    Object.assign(this, details);
  }

  /** Delete it and everything in it. */
  async delete(): Promise<void> {
    await deleteCalendarAsync(this.id);
  }

  /**
   * Read one calendar (an event calendar, or on iOS a reminders list).
   *
   * @param calendarId The calendar.
   * @returns The calendar.
   * @throws `E_CALENDAR_NOT_FOUND` when there is none with that id.
   */
  static async get(calendarId: string): Promise<ExpoCalendar> {
    const found = (await getCalendarsAsync()).find((c) => c.id === calendarId);
    if (!found) {
      throw new CodedError("E_CALENDAR_NOT_FOUND", `There is no calendar with id ${calendarId}.`);
    }
    return calendarObject(found);
  }
}

/** A calendar object filled from `calendar`. */
function calendarObject(calendar: Calendar): ExpoCalendar {
  return Object.assign(new ExpoCalendar(calendar.id), calendar);
}

/**
 * The calendars, as objects (see {@linkcode getCalendarsAsync}).
 *
 * @param entityType `event` or `reminder` (iOS).
 * @returns The calendars.
 */
export async function getCalendars(entityType?: EntityTypes): Promise<ExpoCalendar[]> {
  return (await getCalendarsAsync(entityType)).map(calendarObject);
}

/**
 * Create a calendar (see {@linkcode createCalendarAsync}).
 *
 * @param details The calendar.
 * @returns The new calendar.
 */
export async function createCalendar(details: Partial<Calendar> = {}): Promise<ExpoCalendar> {
  const id = await createCalendarAsync(details);
  return Object.assign(new ExpoCalendar(id), details, { id });
}

/**
 * The system calendar chooser (one calendar). Needs calendar access first.
 *
 * @returns The chosen calendar, or null when canceled.
 */
export async function presentPicker(): Promise<ExpoCalendar | null> {
  const p = plugin("presentPicker", "selectCalendarsWithPrompt");
  const [chosen] = (await p.selectCalendarsWithPrompt({ multiple: false })).result;
  return chosen ? calendarObject(toCalendar(chosen, EntityTypes.EVENT)) : null;
}

/**
 * The events overlapping `[startDate, endDate]` in the given calendars, as objects.
 *
 * @param calendars Calendars or their ids (all calendars when empty).
 * @param startDate The range's start.
 * @param endDate The range's end.
 * @returns The events.
 */
export async function listEvents(
  calendars: (string | ExpoCalendar)[],
  startDate: Date,
  endDate: Date,
): Promise<ExpoCalendarEvent[]> {
  const ids = calendars.map((c) => typeof c === "string" ? c : c.id);
  return (await getEventsAsync(ids, startDate, endDate)).map(eventObject);
}
