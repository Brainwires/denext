/**
 * The system contact picker for `denext/mobile`: `@capgo/capacitor-contacts`'s picker
 * (`CapacitorContacts.pickContact`, installed by `denext mobile add contacts`) in the shell, else
 * the browser's Contact Picker API (`navigator.contacts.select`, Chrome on Android).
 *
 * @module
 */

import { isDismissal } from "./base64.ts";
import { nativePlugin } from "./plugin.ts";

/** A contact from {@linkcode pickContact}. */
export interface PickedContact {
  /** The address-book id, in the shell (the browser's picker gives none). */
  readonly id?: string;
  /** The name to show (`""` when the contact has none). */
  readonly name: string;
  /** The email addresses. */
  readonly emails: readonly string[];
  /** The phone numbers. */
  readonly phoneNumbers: readonly string[];
}

/**
 * The `code` on a {@linkcode pickContact} rejection: `unsupported` (no picker here: no plugin in
 * the shell, and no Contact Picker API in the browser).
 */
export type ContactPickerErrorCode = "unsupported";

/** The `Error` a {@linkcode pickContact} promise rejects with for the code above. */
export interface ContactPickerError extends Error {
  /** Why it failed. */
  readonly code: ContactPickerErrorCode;
}

/** A labelled value as the plugin returns it. */
interface PluginValue {
  value?: string | null;
}

/** A contact as `@capgo/capacitor-contacts` returns it (the fields read here). */
interface PluginContact {
  id?: string;
  displayName?: string | null;
  fullName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  emailAddresses?: PluginValue[] | null;
  phoneNumbers?: PluginValue[] | null;
}

/** The JS side of the plugin's picker. */
interface ContactsPickerPlugin {
  pickContact(o?: { fields?: string[] }): Promise<{ contacts?: PluginContact[] }>;
}

/** The browser's Contact Picker (`navigator.contacts`). */
interface WebContactsManager {
  select(
    properties: string[],
    options?: { multiple?: boolean },
  ): Promise<Array<{ name?: string[]; email?: string[]; tel?: string[] }>>;
  getProperties?(): Promise<string[]>;
}

const WEB_PROPERTIES = ["name", "email", "tel"];

/** A {@linkcode ContactPickerError}. */
function pickerError(code: ContactPickerErrorCode, message: string): ContactPickerError {
  const err = new Error(`pickContact: ${message}`) as Error & { code: ContactPickerErrorCode };
  err.name = "ContactPickerError";
  err.code = code;
  return err;
}

/** The non-empty strings of `values`. */
function strings(values: readonly (string | null | undefined)[] | null | undefined): string[] {
  return (values ?? []).filter((v): v is string => typeof v === "string" && v !== "");
}

/** A plugin contact as a {@linkcode PickedContact}. */
function fromPlugin(c: PluginContact): PickedContact {
  const name = c.displayName || c.fullName ||
    strings([c.givenName, c.familyName]).join(" ");
  const picked: PickedContact = {
    name,
    emails: strings(c.emailAddresses?.map((e) => e.value)),
    phoneNumbers: strings(c.phoneNumbers?.map((p) => p.value)),
  };
  return c.id ? { id: c.id, ...picked } : picked;
}

/** The native picker; a dismissal (an empty result, or a "cancel" rejection) is null. */
async function nativePick(plugin: ContactsPickerPlugin): Promise<PickedContact | null> {
  try {
    const { contacts } = await plugin.pickContact({});
    return contacts?.[0] ? fromPlugin(contacts[0]) : null;
  } catch (err) {
    if (isDismissal(err)) return null;
    throw err;
  }
}

/** The browser's picker; nothing chosen is null. */
async function webPick(manager: WebContactsManager): Promise<PickedContact | null> {
  const offered = await manager.getProperties?.().catch(() => WEB_PROPERTIES) ?? WEB_PROPERTIES;
  const properties = WEB_PROPERTIES.filter((p) => offered.includes(p));
  const [chosen] = await manager.select(properties, { multiple: false });
  if (!chosen) return null;
  return {
    name: strings(chosen.name)[0] ?? "",
    emails: strings(chosen.email),
    phoneNumbers: strings(chosen.tel),
  };
}

/** `navigator.contacts` when the browser has the Contact Picker API. */
function webContacts(): WebContactsManager | undefined {
  const manager = (globalThis as { navigator?: { contacts?: Partial<WebContactsManager> } })
    .navigator?.contacts;
  return typeof manager?.select === "function" ? manager as WebContactsManager : undefined;
}

/**
 * Whether {@linkcode pickContact} has a picker here: the contacts plugin in the shell, or the
 * browser's Contact Picker API.
 *
 * @returns `true` when a picker can open.
 */
export function contactPickerSupported(): boolean {
  return !!nativePlugin<ContactsPickerPlugin>("CapacitorContacts", ["pickContact"]) ||
    !!webContacts();
}

/**
 * Let the user pick one contact with the system picker. It needs no contacts permission: the
 * user hands over just the contact they choose.
 *
 * - In the iOS/Android shell with `denext mobile add contacts`, the plugin's picker
 *   (`CNContactPickerViewController` on iOS, the contacts app's picker on Android).
 * - Otherwise, where the browser has the Contact Picker API (Chrome on Android), its picker,
 *   asked for the name, email addresses and phone numbers (the ones it offers). The browser
 *   opens it only from a user gesture (a click handler). Elsewhere it rejects with code
 *   `unsupported`.
 *
 * A cancelled pick resolves `null` rather than rejecting.
 *
 * @returns The contact, or `null` when the user cancelled. It rejects with a
 * {@linkcode ContactPickerError} (`unsupported`) or the platform's own error.
 * @example
 * ```tsx
 * "use client";
 * import { pickContact } from "denext/mobile";
 *
 * export function InviteFromContacts({ onInvite }: { onInvite: (email: string) => void }) {
 *   return (
 *     <button type="button" onClick={async () => {
 *       const contact = await pickContact();
 *       if (contact?.emails[0]) onInvite(contact.emails[0]);
 *     }}>Invite a contact</button>
 *   );
 * }
 * ```
 */
export async function pickContact(): Promise<PickedContact | null> {
  const plugin = nativePlugin<ContactsPickerPlugin>("CapacitorContacts", ["pickContact"]);
  if (plugin) return await nativePick(plugin);
  const manager = webContacts();
  if (manager) return await webPick(manager);
  throw pickerError(
    "unsupported",
    "no contact picker here: it needs the Capacitor shell with `denext mobile add contacts`, " +
      "or a browser with the Contact Picker API.",
  );
}
