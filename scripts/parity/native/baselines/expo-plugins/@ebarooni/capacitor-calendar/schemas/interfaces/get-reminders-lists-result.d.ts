import type { RemindersList } from './reminders-list.d.ts';
/**
 * @since 7.1.0
 */
export interface GetRemindersListsResult {
    /**
     * All available reminders lists.
     *
     * @platform iOS
     * @since 7.1.0
     */
    result: RemindersList[];
}
