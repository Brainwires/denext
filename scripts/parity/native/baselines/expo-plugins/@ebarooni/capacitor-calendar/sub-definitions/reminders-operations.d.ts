import type { CalendarSource } from '../schemas/interfaces/calendar-source.d.ts';
import type { CreateReminderOptions } from '../schemas/interfaces/create-reminder-options.d.ts';
import type { CreateReminderResult } from '../schemas/interfaces/create-reminder-result.d.ts';
import type { CreateRemindersListOptions } from '../schemas/interfaces/create-reminders-list-options.d.ts';
import type { CreateRemindersListResult } from '../schemas/interfaces/create-reminders-list-result.d.ts';
import type { DeleteReminderOptions } from '../schemas/interfaces/delete-reminder-options.d.ts';
import type { DeleteReminderWithPromptOptions } from '../schemas/interfaces/delete-reminder-with-prompt-options.d.ts';
import type { DeleteRemindersByIdOptions } from '../schemas/interfaces/delete-reminders-by-id-options.d.ts';
import type { DeleteRemindersByIdResult } from '../schemas/interfaces/delete-reminders-by-id-result.d.ts';
import type { DeleteRemindersListOptions } from '../schemas/interfaces/delete-reminders-list-options.d.ts';
import type { GetReminderByIdOptions } from '../schemas/interfaces/get-reminder-by-id-options.d.ts';
import type { GetReminderByIdResult } from '../schemas/interfaces/get-reminder-by-id-result.d.ts';
import type { GetRemindersFromListsOptions } from '../schemas/interfaces/get-reminders-from-lists-options.d.ts';
import type { GetRemindersFromListsResult } from '../schemas/interfaces/get-reminders-from-lists-result.d.ts';
import type { ModifyReminderOptions } from '../schemas/interfaces/modify-reminder-options.d.ts';
import type { RemindersList } from '../schemas/interfaces/reminders-list.d.ts';
import type { UpdateRemindersListOptions } from '../schemas/interfaces/update-reminders-list-options.d.ts';
import type { UpdateRemindersListResult } from '../schemas/interfaces/update-reminders-list-result.d.ts';
export interface RemindersOperations {
    /**
     * Creates a new reminders list.
     *
     * @platform iOS
     * @since 8.1.0
     */
    createRemindersList(options: CreateRemindersListOptions): Promise<CreateRemindersListResult>;
    /**
     * Deletes a reminders list.
     *
     * @platform iOS
     * @since 8.2.0
     */
    deleteRemindersList(options: DeleteRemindersListOptions): Promise<void>;
    /**
     * Retrieves a list of calendar sources.
     *
     * @deprecated Duplicates {@link CalendarOperations#fetchAllCalendarSources}
     * @platform iOS
     * @since 6.6.0
     */
    fetchAllRemindersSources(): Promise<{
        result: CalendarSource[];
    }>;
    /**
     * Opens the reminders app.
     *
     * @platform iOS
     * @since 7.1.0
     */
    openReminders(): Promise<void>;
    /**
     * Retrieves the default reminders list.
     *
     * @platform iOS
     * @since 7.1.0
     */
    getDefaultRemindersList(): Promise<{
        result: RemindersList | null;
    }>;
    /**
     * Retrieves all available reminders lists.
     *
     * @platform iOS
     * @since 7.1.0
     */
    getRemindersLists(): Promise<{
        result: RemindersList[];
    }>;
    /**
     * Creates a reminder.
     *
     * @platform iOS
     * @since 0.5.0
     */
    createReminder(options: CreateReminderOptions): Promise<CreateReminderResult>;
    /**
     * Deletes multiple reminders.
     *
     * @deprecated Use `deleteReminder(...)`.
     * @platform iOS
     * @since 5.3.0
     */
    deleteRemindersById(options: DeleteRemindersByIdOptions): Promise<{
        result: DeleteRemindersByIdResult;
    }>;
    /**
     * Deletes a reminder.
     *
     * @platform iOS
     * @since 7.1.0
     */
    deleteReminder(options: DeleteReminderOptions): Promise<void>;
    /**
     * Modifies a reminder.
     *
     * @platform iOS
     * @since 6.7.0
     */
    modifyReminder(options: ModifyReminderOptions): Promise<void>;
    /**
     * Retrieve a reminder by ID.
     *
     * @platform iOS
     * @since 7.1.0
     */
    getReminderById(options: GetReminderByIdOptions): Promise<GetReminderByIdResult>;
    /**
     * Retrieves reminders from multiple lists.
     *
     * @platform iOS
     * @since 5.3.0
     */
    getRemindersFromLists(options: GetRemindersFromListsOptions): Promise<GetRemindersFromListsResult>;
    /**
     * Opens a dialog to delete a reminder.
     *
     * @platform iOS
     * @since 7.2.0
     */
    deleteReminderWithPrompt(options: DeleteReminderWithPromptOptions): Promise<{
        deleted: boolean;
    }>;
    /**
     * Update a reminders list with options.
     *
     * @platform iOS
     * @since 8.2.0
     */
    updateRemindersList(options: UpdateRemindersListOptions): Promise<UpdateRemindersListResult>;
}
