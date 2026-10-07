import type { CalendarEvent } from './calendar-event.d.ts';
/**
 * @since 8.6.0
 */
export interface ListEventsInRangeResult {
    /**
     * Events that overlap the requested range.
     *
     * @platform Android, iOS
     * @since 8.6.0
     */
    result: CalendarEvent[];
}
