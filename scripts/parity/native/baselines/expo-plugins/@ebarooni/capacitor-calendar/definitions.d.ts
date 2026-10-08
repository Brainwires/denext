import type { CalendarAccess } from './sub-definitions/calendar-access.d.ts';
import type { CalendarOperations } from './sub-definitions/calendar-operations.d.ts';
import type { EventOperations } from './sub-definitions/event-operations.d.ts';
import type { RemindersAccess } from './sub-definitions/reminders-access.d.ts';
import type { RemindersOperations } from './sub-definitions/reminders-operations.d.ts';
export interface CapacitorCalendarPlugin extends CalendarAccess, RemindersAccess, EventOperations, CalendarOperations, RemindersOperations {
}
