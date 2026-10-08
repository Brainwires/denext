/**
 * `expo-contacts/legacy` for denext: Expo's legacy function API (`getContactsAsync`,
 * `addContactAsync`, `presentFormAsync`, …, the enums and the permission calls) in Expo's legacy
 * shapes, the entry SDK 58 keeps for apps that have not moved to the `Contact` / `Group` classes.
 * It is the same implementation `denext/expo/contacts` exports from its main entry (where Expo
 * 58's legacy functions throw and denext's work), over `@capgo/capacitor-contacts` (`denext
 * mobile add contacts`), with the same limits: no containers, no change events, and off the
 * shell every call rejects with `ERR_UNAVAILABLE` except the permissions and `isAvailableAsync`.
 * Here `Contact`, `Group` and `Container` are the legacy record types.
 *
 * @example
 * ```ts
 * import * as Contacts from "denext/expo/contacts/legacy";
 *
 * const { granted } = await Contacts.requestPermissionsAsync();
 * if (granted) {
 *   const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Emails] });
 * }
 * ```
 *
 * @module
 */

export {
  addContactAsync,
  addContactsChangeListener,
  CalendarFormats,
  ContactAccessButton,
  ContactTypes,
  ContainerTypes,
  createGroupAsync,
  Fields,
  getContactByIdAsync,
  getContactsAsync,
  getContainersAsync,
  getDefaultContainerIdAsync,
  getGroupsAsync,
  getPagedContactsAsync,
  getPermissionsAsync,
  hasContactsAsync,
  isAvailableAsync,
  PermissionStatus,
  presentContactPickerAsync,
  presentFormAsync,
  removeContactAsync,
  removeGroupAsync,
  requestPermissionsAsync,
  SortTypes,
  updateContactAsync,
} from "./contacts.ts";
export type {
  Address,
  CalendarFormatType,
  ContactAccessButtonProps,
  ContactQuery,
  ContactResponse,
  ContactSort,
  ContactsPermissionResponse,
  ContactType,
  ContainerQuery,
  ContainerType,
  Date,
  Email,
  ExistingContact,
  FieldType,
  FormOptions,
  GroupQuery,
  Image,
  InstantMessageAddress,
  LegacyContact as Contact,
  LegacyContainer as Container,
  LegacyGroup as Group,
  PermissionExpiration,
  PermissionResponse,
  PhoneNumber,
  Relationship,
  SocialProfile,
  UrlAddress,
} from "./contacts.ts";

/** The native event name the address-book change listener subscribes to. */
export const onContactsChangeEventName = "onContactsChange";
