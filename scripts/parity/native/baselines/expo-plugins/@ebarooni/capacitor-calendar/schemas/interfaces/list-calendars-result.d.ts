import type { Calendar } from './calendar.d.ts';
/**
 * @since 8.4.0
 */
export interface ListCalendarsResult {
    /**
     * All available calendars.
     *
     * @platform Android, iOS
     * @since 8.4.0
     */
    result: Calendar[];
}
