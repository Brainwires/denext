/**
 * `expo-contacts` for denext: the device address book over `@capgo/capacitor-contacts` 8
 * (Capacitor 8, the `CapacitorContacts` plugin, installed by `denext mobile add contacts`).
 *
 * - The legacy function API (`getContactsAsync`, `addContactAsync`, …) speaks Expo's legacy
 *   shapes (`ExistingContact`: `firstName` / `lastName`, `emails`, `phoneNumbers`, a birthday
 *   whose `month` is 0-based) and the class API (`Contact`, `Group`) speaks the new ones.
 * - The plugin reads and writes names, company, job title, note, birthday, emails, phone
 *   numbers, postal addresses, URLs and the photo. Everything else Expo has (nickname,
 *   phonetic names, department, dates, relations, social profiles, IM addresses, favourites,
 *   containers) reads as empty and is not written. Item ids (`emails[i].id`) are positional.
 * - A partial update (`updateContactAsync`, `contact.patch`, the setters) reads the contact,
 *   overlays the change and writes the whole record back: on Android the plugin rewrites the
 *   record, and keeps only names, company, job title, note, emails and phone numbers.
 * - Off the Capacitor shell (or without the plugin) every call rejects with
 *   `ERR_UNAVAILABLE`, except the permission calls, which answer `undetermined` as Expo's web
 *   build does, {@linkcode isAvailableAsync} (`false`) and the change listener (never fires).
 *
 * @example
 * ```ts
 * import * as Contacts from "denext/expo/contacts";
 *
 * const { granted } = await Contacts.requestPermissionsAsync();
 * if (granted) {
 *   const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Emails] });
 *   console.log(data.map((c) => c.name));
 * }
 * ```
 *
 * @module
 */

import { nativePlugin } from "../mobile/plugin.ts";
import {
  type PermissionExpiration,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  type Subscription,
  subscription,
  unavailable,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionResponse, Subscription };

const PKG = "expo-contacts";
const NEEDS_SHELL = "It needs the Capacitor shell with `denext mobile add contacts`.";

// ---- enums ----------------------------------------------------------------------------------

/** The legacy API's contact fields (`ContactQuery.fields`). */
export enum Fields {
  /** The id. */
  ID = "id",
  /** Person or company. */
  ContactType = "contactType",
  /** The display name. */
  Name = "name",
  /** The given name. */
  FirstName = "firstName",
  /** The middle name. */
  MiddleName = "middleName",
  /** The family name. */
  LastName = "lastName",
  /** The maiden name (not read here). */
  MaidenName = "maidenName",
  /** The name prefix. */
  NamePrefix = "namePrefix",
  /** The name suffix. */
  NameSuffix = "nameSuffix",
  /** The nickname (not read here). */
  Nickname = "nickname",
  /** The phonetic given name (not read here). */
  PhoneticFirstName = "phoneticFirstName",
  /** The phonetic middle name (not read here). */
  PhoneticMiddleName = "phoneticMiddleName",
  /** The phonetic family name (not read here). */
  PhoneticLastName = "phoneticLastName",
  /** The birthday. */
  Birthday = "birthday",
  /** A non-Gregorian birthday (not read here). */
  NonGregorianBirthday = "nonGregorianBirthday",
  /** Email addresses. */
  Emails = "emails",
  /** Phone numbers. */
  PhoneNumbers = "phoneNumbers",
  /** Postal addresses. */
  Addresses = "addresses",
  /** Social profiles (not read here). */
  SocialProfiles = "socialProfiles",
  /** Instant-message addresses (not read here). */
  InstantMessageAddresses = "instantMessageAddresses",
  /** URLs. */
  UrlAddresses = "urlAddresses",
  /** The company. */
  Company = "company",
  /** The job title. */
  JobTitle = "jobTitle",
  /** The department (not read here). */
  Department = "department",
  /** Whether there is a photo. */
  ImageAvailable = "imageAvailable",
  /** The photo. */
  Image = "image",
  /** The full-size photo (the same photo here). */
  RawImage = "rawImage",
  /** Extra names (not read here). */
  ExtraNames = "extraNames",
  /** The note. */
  Note = "note",
  /** Other dates (not read here). */
  Dates = "dates",
  /** Relationships (not read here). */
  Relationships = "relationships",
  /** Whether it is a favourite (not read here). */
  IsFavorite = "isFavorite",
}

/** Calendar formats of a legacy {@linkcode Date}. */
export enum CalendarFormats {
  /** Gregorian. */
  Gregorian = "gregorian",
  /** Buddhist. */
  Buddhist = "buddhist",
  /** Chinese. */
  Chinese = "chinese",
  /** Coptic. */
  Coptic = "coptic",
  /** Ethiopic (Amete Mihret). */
  EthiopicAmeteMihret = "ethiopicAmeteMihret",
  /** Ethiopic (Amete Alem). */
  EthiopicAmeteAlem = "ethiopicAmeteAlem",
  /** Hebrew. */
  Hebrew = "hebrew",
  /** ISO 8601. */
  ISO8601 = "iso8601",
  /** Indian. */
  Indian = "indian",
  /** Islamic. */
  Islamic = "islamic",
  /** Islamic civil. */
  IslamicCivil = "islamicCivil",
  /** Japanese. */
  Japanese = "japanese",
  /** Persian. */
  Persian = "persian",
  /** Republic of China. */
  RepublicOfChina = "republicOfChina",
  /** Islamic tabular. */
  IslamicTabular = "islamicTabular",
  /** Islamic Umm al-Qura. */
  IslamicUmmAlQura = "islamicUmmAlQura",
}

/** Kinds of contact container. */
export enum ContainerTypes {
  /** On the device. */
  Local = "local",
  /** An Exchange account. */
  Exchange = "exchange",
  /** A CardDAV account. */
  CardDAV = "cardDAV",
  /** Not assigned. */
  Unassigned = "unassigned",
}

/** Legacy sort orders (`ContactQuery.sort`). */
export enum SortTypes {
  /** The system's order. */
  UserDefault = "userDefault",
  /** By given name. */
  FirstName = "firstName",
  /** By family name. */
  LastName = "lastName",
  /** Unsorted. */
  None = "none",
}

/** Person or company. */
export enum ContactTypes {
  /** A person. */
  Person = "person",
  /** A company. */
  Company = "company",
}

/** The class API's contact fields (`contact.getDetails(fields)`). */
export enum ContactField {
  /** Whether it is a favourite (always `false` here). */
  IS_FAVOURITE = "isFavourite",
  /** The formatted name. */
  FULL_NAME = "fullName",
  /** The given name. */
  GIVEN_NAME = "givenName",
  /** The middle name. */
  MIDDLE_NAME = "middleName",
  /** The family name. */
  FAMILY_NAME = "familyName",
  /** The maiden name (not read here). */
  MAIDEN_NAME = "maidenName",
  /** The nickname (not read here). */
  NICKNAME = "nickname",
  /** The name prefix. */
  PREFIX = "prefix",
  /** The name suffix. */
  SUFFIX = "suffix",
  /** The phonetic given name (not read here). */
  PHONETIC_GIVEN_NAME = "phoneticGivenName",
  /** The phonetic middle name (not read here). */
  PHONETIC_MIDDLE_NAME = "phoneticMiddleName",
  /** The phonetic family name (not read here). */
  PHONETIC_FAMILY_NAME = "phoneticFamilyName",
  /** The company. */
  COMPANY = "company",
  /** The phonetic company name (not read here). */
  PHONETIC_COMPANY_NAME = "phoneticCompanyName",
  /** The department (not read here). */
  DEPARTMENT = "department",
  /** The job title. */
  JOB_TITLE = "jobTitle",
  /** The note. */
  NOTE = "note",
  /** The photo, as a `data:` URI. */
  IMAGE = "image",
  /** The thumbnail (not read here). */
  THUMBNAIL = "thumbnail",
  /** The birthday. */
  BIRTHDAY = "birthday",
  /** A non-Gregorian birthday (not read here). */
  NON_GREGORIAN_BIRTHDAY = "nonGregorianBirthday",
  /** Email addresses. */
  EMAILS = "emails",
  /** Phone numbers. */
  PHONES = "phones",
  /** Postal addresses. */
  ADDRESSES = "addresses",
  /** Extra names (not read here). */
  EXTRA_NAMES = "extraNames",
  /** Other dates (not read here). */
  DATES = "dates",
  /** Relations (not read here). */
  RELATIONS = "relations",
  /** URLs. */
  URL_ADDRESSES = "urlAddresses",
  /** Social profiles (not read here). */
  SOCIAL_PROFILES = "socialProfiles",
  /** Instant-message addresses (not read here). */
  IM_ADDRESSES = "imAddresses",
}

/** The class API's sort orders (`ContactQueryOptions.sortOrder`). */
export enum ContactsSortOrder {
  /** The system's order. */
  UserDefault = "userDefault",
  /** By given name. */
  GivenName = "givenName",
  /** By family name. */
  FamilyName = "familyName",
  /** Unsorted. */
  None = "none",
}

/** Calendars of a {@linkcode NonGregorianBirthday}. */
export enum NonGregorianCalendar {
  /** Buddhist. */
  buddhist = "buddhist",
  /** Chinese. */
  chinese = "chinese",
  /** Coptic. */
  coptic = "coptic",
  /** Ethiopic (Amete Mihret). */
  ethiopicAmeteMihret = "ethiopicAmeteMihret",
  /** Ethiopic (Amete Alem). */
  ethiopicAmeteAlem = "ethiopicAmeteAlem",
  /** Hebrew. */
  hebrew = "hebrew",
  /** Indian. */
  indian = "indian",
  /** Islamic. */
  islamic = "islamic",
  /** Islamic civil. */
  islamicCivil = "islamicCivil",
  /** Japanese. */
  japanese = "japanese",
  /** Persian. */
  persian = "persian",
  /** Republic of China. */
  republicOfChina = "republicOfChina",
}

// ---- legacy types ---------------------------------------------------------------------------

/** A {@linkcode CalendarFormats} member or its string. */
export type CalendarFormatType = CalendarFormats | `${CalendarFormats}`;
/** A {@linkcode ContainerTypes} member or its string. */
export type ContainerType = ContainerTypes | `${ContainerTypes}`;
/** A {@linkcode ContactTypes} member or its string. */
export type ContactType = ContactTypes | `${ContactTypes}`;
/** A {@linkcode Fields} member or its string. */
export type FieldType = Fields | `${Fields}`;
/** A legacy sort order. */
export type ContactSort = `${SortTypes}`;

/** A legacy date: `month` is 0-based, as JavaScript's `Date`. */
export type Date = {
  /** Day of the month (1–31). */
  day: number;
  /** Month, 0-based (0–11). */
  month: number;
  /** Year, when known. */
  year?: number;
  /** Id. */
  id?: string;
  /** Label. */
  label?: string;
  /** Calendar format. */
  format?: CalendarFormatType;
};

/** A legacy relationship (not read here). */
export type Relationship = {
  /** Label. */
  label: string;
  /** Name. */
  name?: string;
  /** Id. */
  id?: string;
};

/** A legacy email address. */
export type Email = {
  /** The address. */
  email?: string;
  /** Whether it is the primary one. */
  isPrimary?: boolean;
  /** Label (`home`, `work`, …). */
  label: string;
  /** Positional id. */
  id?: string;
};

/** A legacy phone number. */
export type PhoneNumber = {
  /** The number. */
  number?: string;
  /** Whether it is the primary one. */
  isPrimary?: boolean;
  /** The number's digits (not read here). */
  digits?: string;
  /** Country code (not read here). */
  countryCode?: string;
  /** Label (`mobile`, `home`, …). */
  label: string;
  /** Positional id. */
  id?: string;
};

/** A legacy postal address. */
export type Address = {
  /** Street. */
  street?: string;
  /** City. */
  city?: string;
  /** Country. */
  country?: string;
  /** Region or state. */
  region?: string;
  /** Neighborhood. */
  neighborhood?: string;
  /** Postal code. */
  postalCode?: string;
  /** PO box (not read here). */
  poBox?: string;
  /** ISO country code. */
  isoCountryCode?: string;
  /** Label. */
  label: string;
  /** Positional id. */
  id?: string;
};

/** A legacy social profile (not read here). */
export type SocialProfile = {
  /** Service. */
  service?: string;
  /** Localized profile. */
  localizedProfile?: string;
  /** URL. */
  url?: string;
  /** Username. */
  username?: string;
  /** User id. */
  userId?: string;
  /** Label. */
  label: string;
  /** Id. */
  id?: string;
};

/** A legacy instant-message address (not read here). */
export type InstantMessageAddress = {
  /** Service. */
  service?: string;
  /** Username. */
  username?: string;
  /** Localized service. */
  localizedService?: string;
  /** Label. */
  label: string;
  /** Id. */
  id?: string;
};

/** A legacy URL. */
export type UrlAddress = {
  /** Label. */
  label: string;
  /** The URL. */
  url?: string;
  /** Positional id. */
  id?: string;
};

/** A legacy contact photo. */
export type Image = {
  /** The photo as a `data:` URI. */
  uri?: string;
  /** Width (not read here). */
  width?: number;
  /** Height (not read here). */
  height?: number;
  /** The photo's base64. */
  base64?: string;
};

/** A legacy contact (Expo's `Contact` type of the legacy API). */
export type LegacyContact = {
  /** Person or company (always `person` here). */
  contactType: ContactType;
  /** The display name. */
  name: string;
  /** Given name. */
  firstName?: string;
  /** Middle name. */
  middleName?: string;
  /** Family name. */
  lastName?: string;
  /** Maiden name (not read or written here). */
  maidenName?: string;
  /** Name prefix. */
  namePrefix?: string;
  /** Name suffix. */
  nameSuffix?: string;
  /** Nickname (not read or written here). */
  nickname?: string;
  /** Phonetic given name (not read or written here). */
  phoneticFirstName?: string;
  /** Phonetic middle name (not read or written here). */
  phoneticMiddleName?: string;
  /** Phonetic family name (not read or written here). */
  phoneticLastName?: string;
  /** Company. */
  company?: string;
  /** Job title. */
  jobTitle?: string;
  /** Department (not read or written here). */
  department?: string;
  /** Note. */
  note?: string;
  /** Whether there is a photo. */
  imageAvailable?: boolean;
  /** The photo. */
  image?: Image;
  /** The full-size photo (the same photo here). */
  rawImage?: Image;
  /** Birthday (`month` 0-based). */
  birthday?: Date;
  /** Other dates (not read or written here). */
  dates?: Date[];
  /** Relationships (not read or written here). */
  relationships?: Relationship[];
  /** Email addresses. */
  emails?: Email[];
  /** Phone numbers. */
  phoneNumbers?: PhoneNumber[];
  /** Postal addresses. */
  addresses?: Address[];
  /** IM addresses (not read or written here). */
  instantMessageAddresses?: InstantMessageAddress[];
  /** URLs. */
  urlAddresses?: UrlAddress[];
  /** Non-Gregorian birthday (not read or written here). */
  nonGregorianBirthday?: Date;
  /** Social profiles (not read or written here). */
  socialProfiles?: SocialProfile[];
  /** Favourite (not read or written here). */
  isFavorite?: boolean;
};

/** A legacy contact with its id. */
export type ExistingContact = LegacyContact & {
  /** The contact's id. */
  id: string;
};

/** A page of legacy contacts. */
export type ContactResponse = {
  /** The contacts. */
  data: ExistingContact[];
  /** Whether more contacts follow this page. */
  hasNextPage: boolean;
  /** Whether contacts precede this page (`pageOffset > 0`). */
  hasPreviousPage: boolean;
};

/** A legacy contact query. */
export type ContactQuery = {
  /** Page size; `0` or unset returns every contact. */
  pageSize?: number;
  /** How many contacts to skip. */
  pageOffset?: number;
  /** Fields to read; unset reads every field. */
  fields?: FieldType[];
  /** Sort order. */
  sort?: ContactSort;
  /** Keep contacts whose name contains this (case-insensitive). */
  name?: string;
  /** Keep the contact(s) with this id or these ids. */
  id?: string | string[];
  /** Keep the members of this group. */
  groupId?: string;
  /** Ignored here (the plugin has no containers). */
  containerId?: string;
  /** Ignored here. */
  rawContacts?: boolean;
};

/** Options of a contact form. Only `allowsEditing` is honoured here. */
export type FormOptions = {
  /** Properties to show (ignored). */
  displayedPropertyKeys?: (FieldType | ContactField)[];
  /** Message (ignored). */
  message?: string;
  /** Alternate name (ignored). */
  alternateName?: string;
  /** Whether the contact can be edited (`false` shows it read-only). */
  allowsEditing?: boolean;
  /** Actions (ignored). */
  allowsActions?: boolean;
  /** Linked contacts (ignored). */
  shouldShowLinkedContacts?: boolean;
  /** New contact (ignored). */
  isNew?: boolean;
  /** Cancel button title (ignored). */
  cancelButtonTitle?: string;
  /** Show a cancel button (ignored). */
  showsCancelButton?: boolean;
  /** No animation (ignored). */
  preventAnimation?: boolean;
  /** Group (ignored). */
  groupId?: string;
};

/** A legacy group query. */
export type GroupQuery = {
  /** Keep the group with this id. */
  groupId?: string;
  /** Keep groups with this name. */
  groupName?: string;
  /** Ignored here (the plugin has no containers). */
  containerId?: string;
};

/** A legacy group. */
export type LegacyGroup = {
  /** Name. */
  name?: string;
  /** Id. */
  id?: string;
};

/** A legacy container query. */
export type ContainerQuery = {
  /** Contact id. */
  contactId?: string;
  /** Group id. */
  groupId?: string;
  /** Container id(s). */
  containerId?: string | string[];
};

/** A legacy container. */
export type LegacyContainer = {
  /** Name. */
  name: string;
  /** Id. */
  id: string;
  /** Kind. */
  type: ContainerType;
};

// ---- class API types ------------------------------------------------------------------------

/** A new email address. */
export type NewEmail = {
  /** Label. */
  label?: string;
  /** The address. */
  address?: string;
};
/** An email address of a contact. */
export type ExistingEmail = NewEmail & {
  /** Positional id. */
  id: string;
};
/** A new phone number. */
export type NewPhone = {
  /** Label. */
  label?: string;
  /** The number. */
  number?: string;
};
/** A phone number of a contact. */
export type ExistingPhone = NewPhone & {
  /** Positional id. */
  id: string;
};
/** A new date. */
export type NewDate = {
  /** Label. */
  label?: string;
  /** The date. */
  date?: ContactDate;
};
/** A date of a contact. */
export type ExistingDate = NewDate & {
  /** Id. */
  id: string;
};
/** A new extra name. */
export type NewExtraName = {
  /** Label. */
  label?: string;
  /** The name. */
  name?: string;
};
/** An extra name of a contact. */
export type ExistingExtraName = NewExtraName & {
  /** Id. */
  id: string;
};
/** A new postal address. */
export type NewAddress = {
  /** Label. */
  label?: string;
  /** Street. */
  street?: string;
  /** City. */
  city?: string;
  /** State. */
  state?: string;
  /** Postal code. */
  postcode?: string;
  /** Region (written as the state when `state` is unset). */
  region?: string;
  /** Country. */
  country?: string;
};
/** A postal address of a contact. */
export type ExistingAddress = NewAddress & {
  /** Positional id. */
  id: string;
};
/** A new relation. */
export type NewRelation = {
  /** Label. */
  label?: string;
  /** Name. */
  name?: string;
};
/** A relation of a contact. */
export type ExistingRelation = NewRelation & {
  /** Id. */
  id: string;
};
/** A new URL. */
export type NewUrlAddress = {
  /** Label. */
  label?: string;
  /** The URL. */
  url?: string;
};
/** A URL of a contact. */
export type ExistingUrlAddress = NewUrlAddress & {
  /** Positional id. */
  id: string;
};
/** A new IM address. */
export type NewImAddress = {
  /** Label. */
  label?: string;
  /** Username. */
  username?: string;
  /** Service. */
  service?: string;
};
/** An IM address of a contact. */
export type ExistingImAddress = NewImAddress & {
  /** Id. */
  id: string;
};
/** A new social profile. */
export type NewSocialProfile = {
  /** Label. */
  label?: string;
  /** Username. */
  username?: string;
  /** Service. */
  service?: string;
  /** URL. */
  url?: string;
  /** User id. */
  userId?: string;
};
/** A social profile of a contact. */
export type ExistingSocialProfile = NewSocialProfile & {
  /** Id. */
  id: string;
};

/** A class-API date: `month` is 1–12. */
export type ContactDate = {
  /** Year, when known. */
  year?: number;
  /** Month (1–12). */
  month: number;
  /** Day (1–31). */
  day: number;
};

/** A non-Gregorian birthday. */
export type NonGregorianBirthday = {
  /** Year. */
  year?: number;
  /** Month. */
  month: number;
  /** Day. */
  day: number;
  /** Calendar. */
  calendar: NonGregorianCalendar;
};

/** A partial change to a contact (`contact.patch`); `null` clears a text field. */
export type ContactPatch = {
  /** Favourite (not written here). */
  isFavourite?: boolean | null;
  /** Given name. */
  givenName?: string | null;
  /** Middle name. */
  middleName?: string | null;
  /** Family name. */
  familyName?: string | null;
  /** Nickname (not written here). */
  nickname?: string | null;
  /** Maiden name (not written here). */
  maidenName?: string | null;
  /** Name prefix. */
  prefix?: string | null;
  /** Name suffix. */
  suffix?: string | null;
  /** Phonetic given name (not written here). */
  phoneticGivenName?: string | null;
  /** Phonetic middle name (not written here). */
  phoneticMiddleName?: string | null;
  /** Phonetic family name (not written here). */
  phoneticFamilyName?: string | null;
  /** Company. */
  company?: string | null;
  /** Department (not written here). */
  department?: string | null;
  /** Job title. */
  jobTitle?: string | null;
  /** Phonetic company name (not written here). */
  phoneticCompanyName?: string | null;
  /** Note. */
  note?: string | null;
  /** Image URI (not written here). */
  image?: string | null;
  /** Birthday. */
  birthday?: ContactDate | null;
  /** Non-Gregorian birthday (not written here). */
  nonGregorianBirthday?: NonGregorianBirthday | null;
  /** Emails (replaces the list). */
  emails?: (ExistingEmail | NewEmail)[];
  /** Phones (replaces the list). */
  phones?: (ExistingPhone | NewPhone)[];
  /** Dates (not written here). */
  dates?: (ExistingDate | NewDate)[];
  /** Extra names (not written here). */
  extraNames?: (ExistingExtraName | NewExtraName)[];
  /** Addresses (replaces the list). */
  addresses?: (ExistingAddress | NewAddress)[];
  /** Relations (not written here). */
  relations?: (ExistingRelation | NewRelation)[];
  /** URLs (replaces the list). */
  urlAddresses?: (ExistingUrlAddress | NewUrlAddress)[];
  /** Social profiles (not written here). */
  socialProfiles?: (ExistingSocialProfile | NewSocialProfile)[];
  /** IM addresses (not written here). */
  imAddresses?: (ExistingImAddress | NewImAddress)[];
};

/** A new contact (`Contact.create`). */
export type CreateContactRecord = {
  /** Favourite (not written here). */
  isFavourite?: boolean;
  /** Given name. */
  givenName?: string;
  /** Middle name. */
  middleName?: string;
  /** Family name. */
  familyName?: string;
  /** Maiden name (not written here). */
  maidenName?: string;
  /** Nickname (not written here). */
  nickname?: string;
  /** Name prefix. */
  prefix?: string;
  /** Name suffix. */
  suffix?: string;
  /** Phonetic given name (not written here). */
  phoneticGivenName?: string;
  /** Phonetic middle name (not written here). */
  phoneticMiddleName?: string;
  /** Phonetic family name (not written here). */
  phoneticFamilyName?: string;
  /** Company. */
  company?: string;
  /** Department (not written here). */
  department?: string;
  /** Job title. */
  jobTitle?: string;
  /** Phonetic company name (not written here). */
  phoneticCompanyName?: string;
  /** Note. */
  note?: string;
  /** Image URI (not written here). */
  image?: string;
  /** Birthday. */
  birthday?: ContactDate;
  /** Non-Gregorian birthday (not written here). */
  nonGregorianBirthday?: NonGregorianBirthday;
  /** Emails. */
  emails?: NewEmail[];
  /** Dates (not written here). */
  dates?: NewDate[];
  /** Phones. */
  phones?: NewPhone[];
  /** Addresses. */
  addresses?: NewAddress[];
  /** Relations (not written here). */
  relations?: NewRelation[];
  /** URLs. */
  urlAddresses?: NewUrlAddress[];
  /** IM addresses (not written here). */
  imAddresses?: NewImAddress[];
  /** Social profiles (not written here). */
  socialProfiles?: NewSocialProfile[];
  /** Extra names (not written here). */
  extraNames?: NewExtraName[];
};

/** Every detail of a contact, as the class API reads it. */
export type ContactDetails = {
  /** Favourite (always `false` here). */
  isFavourite: boolean;
  /** Formatted name. */
  fullName: string | null;
  /** Given name. */
  givenName: string | null;
  /** Middle name. */
  middleName: string | null;
  /** Family name. */
  familyName: string | null;
  /** Maiden name (always `null` here). */
  maidenName?: string | null;
  /** Nickname (always `null` here). */
  nickname?: string | null;
  /** Name prefix. */
  prefix: string | null;
  /** Name suffix. */
  suffix: string | null;
  /** Phonetic given name (always `null` here). */
  phoneticGivenName: string | null;
  /** Phonetic middle name (always `null` here). */
  phoneticMiddleName: string | null;
  /** Phonetic family name (always `null` here). */
  phoneticFamilyName: string | null;
  /** Company. */
  company: string | null;
  /** Department (always `null` here). */
  department: string | null;
  /** Job title. */
  jobTitle?: string;
  /** Phonetic company name (unset here). */
  phoneticCompanyName?: string;
  /** Note. */
  note: string | null;
  /** The photo, as a `data:` URI. */
  image: string | null;
  /** Thumbnail (always `null` here). */
  thumbnail: string | null;
  /** Birthday. */
  birthday?: ContactDate | null;
  /** Non-Gregorian birthday (always `null` here). */
  nonGregorianBirthday?: NonGregorianBirthday | null;
  /** Emails. */
  emails: ExistingEmail[];
  /** Dates (always empty here). */
  dates: ExistingDate[];
  /** Phones. */
  phones: ExistingPhone[];
  /** Extra names (always empty here). */
  extraNames: ExistingExtraName[];
  /** Addresses. */
  addresses: ExistingAddress[];
  /** Relations (always empty here). */
  relations: ExistingRelation[];
  /** URLs. */
  urlAddresses: ExistingUrlAddress[];
  /** Social profiles (always empty here). */
  socialProfiles: ExistingSocialProfile[];
  /** IM addresses (always empty here). */
  imAddresses: ExistingImAddress[];
};

/** Options of `Contact.getAll`. */
export type ContactQueryOptions = {
  /** Most contacts to return. */
  limit?: number;
  /** How many contacts to skip. */
  offset?: number;
  /** Sort order. */
  sortOrder?: ContactsSortOrder;
  /** Keep contacts whose name contains this (case-insensitive). */
  name?: string;
  /** Ignored here. */
  rawContacts?: boolean;
};

/** Options of `Contact.presentCreateForm` (ignored here). */
export type CreateFormOptions = {
  /** Cancel button title. */
  cancelButtonTitle?: string;
  /** Show a cancel button. */
  showsCancelButton?: boolean;
  /** No animation. */
  preventAnimation?: boolean;
};

/** A {@linkcode ContactField}'s key in {@linkcode ContactDetails}. */
export type ContactFieldKey = { [K in ContactField]: `${K}` };

/** The details `getDetails(fields)` returns: the id and the asked-for fields. */
export type PartialContactDetails<T extends readonly ContactField[]> =
  & {
    /** The contact's id. */
    id: string;
  }
  & { [K in T[number]]: ContactDetails[K] };

/** A contacts permission answer, with how much of the address book is shared. */
export type ContactsPermissionResponse = PermissionResponse & {
  /** `all`, `limited` (iOS 18 limited access) or `none`. */
  accessPrivileges?: "all" | "limited" | "none";
};

/** Expo's name for a listener subscription. */
export type EventSubscription = Subscription;

// ---- the plugin -----------------------------------------------------------------------------

/** A labelled value as the plugin reads and writes it. */
interface PluginLabelled {
  value?: string;
  type?: string;
  label?: string;
  isPrimary?: boolean;
}

/** A postal address as the plugin reads and writes it. */
interface PluginAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  isoCountryCode?: string;
  neighborhood?: string;
  type?: string;
  label?: string;
  isPrimary?: boolean;
}

/** A contact as `@capgo/capacitor-contacts` reads and writes it (month 1–12). */
interface PluginContact {
  id?: string;
  displayName?: string | null;
  fullName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  middleName?: string | null;
  namePrefix?: string | null;
  nameSuffix?: string | null;
  organizationName?: string | null;
  jobTitle?: string | null;
  note?: string | null;
  photo?: string | null;
  birthday?: { day?: number; month?: number; year?: number } | null;
  groupIds?: string[] | null;
  emailAddresses?: PluginLabelled[] | null;
  phoneNumbers?: PluginLabelled[] | null;
  postalAddresses?: PluginAddress[] | null;
  urlAddresses?: PluginLabelled[] | null;
  account?: unknown;
}

/** A permission state as the plugin reports it. */
type PluginPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale" | "limited";

/** The JS side of `@capgo/capacitor-contacts` (the calls used here). */
interface ContactsPlugin {
  countContacts(): Promise<{ count: number }>;
  createContact(o: { contact: PluginContact }): Promise<{ id: string }>;
  deleteContactById(o: { id: string }): Promise<void>;
  displayContactById(o: { id: string }): Promise<void>;
  displayCreateContact(o?: { contact?: PluginContact }): Promise<{ id?: string }>;
  displayUpdateContactById(o: { id: string }): Promise<void>;
  getContactById(o: { id: string; fields?: string[] }): Promise<{ contact: PluginContact | null }>;
  getContacts(
    o?: { fields?: string[]; limit?: number; offset?: number },
  ): Promise<{ contacts: PluginContact[] }>;
  getGroups(): Promise<{ groups: { id: string; name: string }[] }>;
  createGroup(o: { group: { name: string } }): Promise<{ id: string }>;
  deleteGroupById(o: { id: string }): Promise<void>;
  pickContact(o?: { fields?: string[] }): Promise<{ contacts: PluginContact[] }>;
  updateContactById(o: { id: string; contact: PluginContact }): Promise<void>;
  isAvailable(): Promise<{ isAvailable: boolean }>;
  checkPermissions(): Promise<{ readContacts: PluginPermission; writeContacts: PluginPermission }>;
  requestPermissions(): Promise<
    { readContacts: PluginPermission; writeContacts: PluginPermission }
  >;
}

const METHODS: (keyof ContactsPlugin)[] = [
  "countContacts",
  "createContact",
  "deleteContactById",
  "getContactById",
  "getContacts",
  "updateContactById",
  "checkPermissions",
  "requestPermissions",
];

/** The plugin, or undefined off the shell / without it. */
function plugin(): ContactsPlugin | undefined {
  return nativePlugin<ContactsPlugin>("CapacitorContacts", METHODS);
}

/** The plugin, or throw Expo's `ERR_UNAVAILABLE` for `name`. */
function need(name: string): ContactsPlugin {
  const p = plugin();
  if (!p) throw unavailable(PKG, name, NEEDS_SHELL);
  return p;
}

/** `ERR_UNAVAILABLE` for a call the plugin cannot make at all. */
function cannot(name: string, what: string): Promise<never> {
  return Promise.reject(
    unavailable(PKG, name, `@capgo/capacitor-contacts has no ${what}.`),
  );
}

// ---- mapping --------------------------------------------------------------------------------

/** `value` without its undefined keys. */
function defined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/** A plugin string (null and "" read as absent). */
function str(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The plugin type of an Expo label (`home` → `HOME`), or `CUSTOM` with the label. */
function toType(label: string | undefined, types: readonly string[]): {
  type?: string;
  label?: string;
} {
  if (!label) return {};
  const type = label.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return types.includes(type) ? { type } : { type: "CUSTOM", label };
}

/** The Expo label of a plugin entry (`WORK_MOBILE` → `work mobile`). */
function toLabel(entry: { type?: string; label?: string }): string {
  if (entry.label) return entry.label;
  return (entry.type ?? "other").toLowerCase().replace(/_/g, " ");
}

const EMAIL_TYPES = ["HOME", "WORK", "OTHER", "ICLOUD", "CUSTOM"] as const;
const PHONE_TYPES = [
  "ASSISTANT",
  "CALLBACK",
  "CAR",
  "COMPANY_MAIN",
  "FAX_HOME",
  "FAX_WORK",
  "HOME",
  "HOME_FAX",
  "ISDN",
  "MAIN",
  "MMS",
  "MOBILE",
  "OTHER",
  "OTHER_FAX",
  "PAGER",
  "RADIO",
  "TELEX",
  "TTY_TDD",
  "WORK",
  "WORK_MOBILE",
  "WORK_PAGER",
] as const;
const ADDRESS_TYPES = ["HOME", "WORK", "OTHER"] as const;
const URL_TYPES = [
  "BLOG",
  "FTP",
  "HOME",
  "HOMEPAGE",
  "OTHER",
  "PROFILE",
  "SCHOOL",
  "WORK",
] as const;

/** A plugin labelled value from an Expo `label` + `value`. */
function labelled(
  value: string | undefined,
  label: string | undefined,
  types: readonly string[],
  isPrimary?: boolean,
): PluginLabelled {
  return defined({ value: value ?? "", ...toType(label, types), isPrimary });
}

/** A plugin postal address from Expo's fields. */
function pluginAddress(a: {
  street?: string;
  city?: string;
  state?: string;
  region?: string;
  postalCode?: string;
  postcode?: string;
  country?: string;
  isoCountryCode?: string;
  neighborhood?: string;
  label?: string;
}): PluginAddress {
  return defined({
    street: a.street,
    city: a.city,
    state: a.state ?? a.region,
    postalCode: a.postalCode ?? a.postcode,
    country: a.country,
    isoCountryCode: a.isoCountryCode,
    neighborhood: a.neighborhood,
    ...toType(a.label, ADDRESS_TYPES),
  });
}

/** The photo's base64 as a `data:` URI (its type sniffed from the first bytes). */
function photoUri(base64: string): string {
  const type = base64.startsWith("iVBOR")
    ? "image/png"
    : base64.startsWith("R0lG")
    ? "image/gif"
    : "image/jpeg";
  return `data:${type};base64,${base64}`;
}

/** A name to show: the plugin's display name, else the parts. */
function displayName(c: PluginContact): string {
  return str(c.displayName) ?? str(c.fullName) ??
    [str(c.givenName), str(c.familyName)].filter(Boolean).join(" ");
}

/** A plugin contact as Expo's legacy `ExistingContact`. */
function toLegacy(c: PluginContact): ExistingContact {
  const photo = str(c.photo);
  const image = photo ? { uri: photoUri(photo), base64: photo } : undefined;
  const b = c.birthday;
  return defined<ExistingContact>({
    id: c.id ?? "",
    contactType: ContactTypes.Person,
    name: displayName(c),
    firstName: str(c.givenName),
    middleName: str(c.middleName),
    lastName: str(c.familyName),
    namePrefix: str(c.namePrefix),
    nameSuffix: str(c.nameSuffix),
    company: str(c.organizationName),
    jobTitle: str(c.jobTitle),
    note: str(c.note),
    birthday: b?.day !== undefined && b.month !== undefined
      ? defined({ day: b.day, month: b.month - 1, year: b.year, format: CalendarFormats.Gregorian })
      : undefined,
    emails: c.emailAddresses?.map((e, i) =>
      defined({ id: String(i), email: e.value, label: toLabel(e), isPrimary: e.isPrimary })
    ),
    phoneNumbers: c.phoneNumbers?.map((p, i) =>
      defined({ id: String(i), number: p.value, label: toLabel(p), isPrimary: p.isPrimary })
    ),
    addresses: c.postalAddresses?.map((a, i) =>
      defined({
        id: String(i),
        label: toLabel(a),
        street: a.street,
        city: a.city,
        region: a.state,
        postalCode: a.postalCode,
        country: a.country,
        isoCountryCode: a.isoCountryCode,
        neighborhood: a.neighborhood,
      })
    ),
    urlAddresses: c.urlAddresses?.map((u, i) =>
      defined({ id: String(i), url: u.value, label: toLabel(u) })
    ),
    imageAvailable: c.photo === undefined ? undefined : photo !== undefined,
    image,
    rawImage: image,
  });
}

/** An Expo legacy contact (or part of one) as the plugin's record. */
function fromLegacy(c: Partial<LegacyContact>): PluginContact {
  const b = c.birthday;
  return defined<PluginContact>({
    givenName: c.firstName,
    familyName: c.lastName,
    middleName: c.middleName,
    namePrefix: c.namePrefix,
    nameSuffix: c.nameSuffix,
    organizationName: c.company,
    jobTitle: c.jobTitle,
    note: c.note,
    birthday: b ? defined({ day: b.day, month: b.month + 1, year: b.year }) : undefined,
    emailAddresses: c.emails?.map((e) => labelled(e.email, e.label, EMAIL_TYPES, e.isPrimary)),
    phoneNumbers: c.phoneNumbers?.map((p) => labelled(p.number, p.label, PHONE_TYPES, p.isPrimary)),
    postalAddresses: c.addresses?.map(pluginAddress),
    urlAddresses: c.urlAddresses?.map((u) => labelled(u.url, u.label, URL_TYPES)),
  });
}

/** A text patch: `null` clears (written as ""), undefined leaves alone. */
function text(value: string | null | undefined): string | undefined {
  return value === null ? "" : value;
}

/** A class-API record or patch as the plugin's record. */
function fromRecord(c: ContactPatch | CreateContactRecord): PluginContact {
  return defined<PluginContact>({
    givenName: text(c.givenName),
    familyName: text(c.familyName),
    middleName: text(c.middleName),
    namePrefix: text(c.prefix),
    nameSuffix: text(c.suffix),
    organizationName: text(c.company),
    jobTitle: text(c.jobTitle),
    note: text(c.note),
    birthday: c.birthday ? defined({ ...c.birthday }) : undefined,
    emailAddresses: c.emails?.map((e) => labelled(e.address, e.label, EMAIL_TYPES)),
    phoneNumbers: c.phones?.map((p) => labelled(p.number, p.label, PHONE_TYPES)),
    postalAddresses: c.addresses?.map(pluginAddress),
    urlAddresses: c.urlAddresses?.map((u) => labelled(u.url, u.label, URL_TYPES)),
  });
}

/** A plugin contact as the class API's details. */
function toDetails(c: PluginContact): ContactDetails {
  const b = c.birthday;
  const photo = str(c.photo);
  return {
    isFavourite: false,
    fullName: str(c.fullName) ?? str(c.displayName) ?? null,
    givenName: str(c.givenName) ?? null,
    middleName: str(c.middleName) ?? null,
    familyName: str(c.familyName) ?? null,
    maidenName: null,
    nickname: null,
    prefix: str(c.namePrefix) ?? null,
    suffix: str(c.nameSuffix) ?? null,
    phoneticGivenName: null,
    phoneticMiddleName: null,
    phoneticFamilyName: null,
    company: str(c.organizationName) ?? null,
    department: null,
    jobTitle: str(c.jobTitle),
    note: str(c.note) ?? null,
    image: photo ? photoUri(photo) : null,
    thumbnail: null,
    birthday: b?.day !== undefined && b.month !== undefined
      ? defined({ day: b.day, month: b.month, year: b.year })
      : null,
    nonGregorianBirthday: null,
    emails: (c.emailAddresses ?? []).map((e, i) => ({
      id: String(i),
      address: e.value,
      label: toLabel(e),
    })),
    dates: [],
    phones: (c.phoneNumbers ?? []).map((p, i) => ({
      id: String(i),
      number: p.value,
      label: toLabel(p),
    })),
    extraNames: [],
    addresses: (c.postalAddresses ?? []).map((a, i) =>
      defined({
        id: String(i),
        label: toLabel(a),
        street: a.street,
        city: a.city,
        state: a.state,
        postcode: a.postalCode,
        country: a.country,
      })
    ),
    relations: [],
    urlAddresses: (c.urlAddresses ?? []).map((u, i) => ({
      id: String(i),
      url: u.value,
      label: toLabel(u),
    })),
    socialProfiles: [],
    imAddresses: [],
  };
}

/** The plugin fields that hold a legacy field (empty: the plugin does not have it). */
const LEGACY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  firstName: ["givenName"],
  middleName: ["middleName"],
  lastName: ["familyName"],
  namePrefix: ["namePrefix"],
  nameSuffix: ["nameSuffix"],
  company: ["organizationName"],
  jobTitle: ["jobTitle"],
  note: ["note"],
  birthday: ["birthday"],
  emails: ["emailAddresses"],
  phoneNumbers: ["phoneNumbers"],
  addresses: ["postalAddresses"],
  urlAddresses: ["urlAddresses"],
  image: ["photo"],
  rawImage: ["photo"],
  imageAvailable: ["photo"],
};

/** The plugin fields that hold a class-API field. */
const DETAIL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  fullName: ["fullName", "displayName"],
  givenName: ["givenName"],
  middleName: ["middleName"],
  familyName: ["familyName"],
  prefix: ["namePrefix"],
  suffix: ["nameSuffix"],
  company: ["organizationName"],
  jobTitle: ["jobTitle"],
  note: ["note"],
  image: ["photo"],
  birthday: ["birthday"],
  emails: ["emailAddresses"],
  phones: ["phoneNumbers"],
  addresses: ["postalAddresses"],
  urlAddresses: ["urlAddresses"],
};

/** The name fields every query reads (a legacy contact always has `name`). */
const NAME_FIELDS = ["displayName", "fullName", "givenName", "familyName"];

/** The plugin fields for `fields` through `map` plus `extra`, or undefined for all. */
function pluginFields(
  fields: readonly string[] | undefined,
  map: Readonly<Record<string, readonly string[]>>,
  extra: readonly string[],
): string[] | undefined {
  if (!fields) return undefined;
  return [...new Set([...extra, ...fields.flatMap((f) => map[f] ?? [])])];
}

/** What {@linkcode query} needs. */
interface Query {
  limit?: number;
  offset?: number;
  sort?: string;
  name?: string;
  ids?: string[];
  groupId?: string;
  fields?: string[];
}

/** Order two contacts by `first` then `second` name part. */
function byName(first: keyof PluginContact, second: keyof PluginContact) {
  return (a: PluginContact, b: PluginContact): number => {
    const key = (c: PluginContact) =>
      `${str(c[first] as string) ?? ""}\u0000${str(c[second] as string) ?? ""}`.toLowerCase();
    return key(a).localeCompare(key(b));
  };
}

/** A page of contacts, as {@linkcode query} returns it. */
interface ContactPage {
  contacts: PluginContact[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** The query's whole matching list: by id, else every contact, then filtered by name and group. */
async function wholeList(
  p: ContactsPlugin,
  q: Query,
  fields: string[] | undefined,
): Promise<PluginContact[]> {
  let all: PluginContact[];
  if (q.ids) {
    const found = await Promise.all(q.ids.map((id) => p.getContactById(defined({ id, fields }))));
    all = found.map((r) => r.contact).filter((c): c is PluginContact => c !== null);
  } else {
    all = (await p.getContacts(defined({ fields }))).contacts;
  }
  if (q.name !== undefined) {
    const needle = q.name.toLowerCase();
    all = all.filter((c) => displayName(c).toLowerCase().includes(needle));
  }
  if (q.groupId !== undefined) all = all.filter((c) => c.groupIds?.includes(q.groupId!));
  return all;
}

/** `all` sorted by `sort` (unchanged without one). */
function sorted(all: PluginContact[], sort: "firstName" | "lastName" | undefined): PluginContact[] {
  if (sort === "firstName") return [...all].sort(byName("givenName", "familyName"));
  if (sort === "lastName") return [...all].sort(byName("familyName", "givenName"));
  return all;
}

/**
 * Read a page of contacts: the plugin pages when nothing needs the whole list (a name or
 * group filter, an id list, a sort other than the system's); otherwise it is read whole and
 * filtered, sorted and paged here.
 */
async function query(p: ContactsPlugin, q: Query): Promise<ContactPage> {
  const limit = q.limit && q.limit > 0 ? q.limit : undefined;
  const offset = q.offset && q.offset > 0 ? q.offset : 0;
  const sort = q.sort === "firstName" || q.sort === "lastName" ? q.sort : undefined;
  const fields = q.fields && q.groupId ? [...q.fields, "groupIds"] : q.fields;
  const whole = q.name !== undefined || q.groupId !== undefined || q.ids !== undefined ||
    sort !== undefined || limit === undefined;
  if (!whole) {
    const { contacts } = await p.getContacts(defined({ fields, limit: limit + 1, offset }));
    return {
      contacts: contacts.slice(0, limit),
      hasNextPage: contacts.length > limit,
      hasPreviousPage: offset > 0,
    };
  }
  const all = sorted(await wholeList(p, q, fields), sort);
  const end = limit === undefined ? all.length : offset + limit;
  return {
    contacts: all.slice(offset, end),
    hasNextPage: end < all.length,
    hasPreviousPage: offset > 0,
  };
}

/** The whole stored record of `id` (without its read-only keys), for a read-modify-write. */
async function stored(p: ContactsPlugin, id: string): Promise<PluginContact> {
  const { contact } = await p.getContactById({ id });
  const { id: _id, displayName: _d, fullName: _f, account: _a, ...rest } = contact ?? {};
  const out: PluginContact = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== null && value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Overlay `change` on the stored record of `id` and write it back. */
async function writeMerged(
  p: ContactsPlugin,
  id: string,
  change: PluginContact,
  clearBirthday = false,
): Promise<void> {
  const merged = { ...await stored(p, id), ...change };
  if (clearBirthday) delete merged.birthday;
  await p.updateContactById({ id, contact: merged });
}

// ---- permissions ----------------------------------------------------------------------------

/** Expo's answer from the plugin's read + write states. */
function toPermission(
  state: { readContacts: PluginPermission; writeContacts: PluginPermission },
): ContactsPermissionResponse {
  const states = [state.readContacts, state.writeContacts];
  const ok = (s: PluginPermission) => s === "granted" || s === "limited";
  if (states.every(ok)) {
    const limited = states.includes("limited");
    return {
      ...permissionResponse(PermissionStatus.GRANTED),
      accessPrivileges: limited ? "limited" : "all",
    };
  }
  if (states.includes("denied")) {
    return {
      ...permissionResponse(PermissionStatus.DENIED),
      canAskAgain: false,
      accessPrivileges: "none",
    };
  }
  if (states.includes("prompt-with-rationale")) {
    return {
      ...permissionResponse(PermissionStatus.DENIED),
      canAskAgain: true,
      accessPrivileges: "none",
    };
  }
  return { ...permissionResponse(PermissionStatus.UNDETERMINED), accessPrivileges: "none" };
}

/**
 * The contacts permission, without prompting. Read and write are asked together; `granted`
 * means both (iOS 18 limited access reads as granted with `accessPrivileges: "limited"`).
 *
 * @returns The answer; `undetermined` off the shell, as Expo's web build.
 */
export async function getPermissionsAsync(): Promise<ContactsPermissionResponse> {
  const p = plugin();
  if (!p) return permissionResponse(PermissionStatus.UNDETERMINED);
  return toPermission(await p.checkPermissions());
}

/**
 * Ask for the contacts permission (read and write).
 *
 * @returns The answer; `undetermined` off the shell, as Expo's web build.
 */
export async function requestPermissionsAsync(): Promise<ContactsPermissionResponse> {
  const p = plugin();
  if (!p) return permissionResponse(PermissionStatus.UNDETERMINED);
  return toPermission(await p.requestPermissions());
}

// ---- the legacy API -------------------------------------------------------------------------

/**
 * Whether the address book can be used: the plugin's answer in the shell.
 *
 * @returns `false` off the shell or without the plugin.
 */
export async function isAvailableAsync(): Promise<boolean> {
  const p = plugin();
  if (!p || typeof p.isAvailable !== "function") return false;
  return (await p.isAvailable()).isAvailable === true;
}

/**
 * Whether the address book has any contact.
 *
 * @returns `true` when it holds at least one.
 */
export async function hasContactsAsync(): Promise<boolean> {
  return (await need("hasContactsAsync").countContacts()).count > 0;
}

/**
 * A page of contacts. `pageSize` / `pageOffset` page it, `name` keeps names containing the
 * text, `id` keeps those ids, `groupId` keeps the group's members, `sort` orders by given or
 * family name, and `fields` limits what is read.
 *
 * @param contactQuery The query.
 * @returns The page, with whether contacts follow and precede it.
 */
export async function getContactsAsync(contactQuery: ContactQuery = {}): Promise<ContactResponse> {
  const p = need("getContactsAsync");
  const q = contactQuery;
  const { contacts, hasNextPage, hasPreviousPage } = await query(p, {
    limit: q.pageSize,
    offset: q.pageOffset,
    sort: q.sort,
    name: q.name,
    ids: q.id === undefined ? undefined : Array.isArray(q.id) ? q.id : [q.id],
    groupId: q.groupId,
    fields: pluginFields(q.fields, LEGACY_FIELDS, NAME_FIELDS),
  });
  return { data: contacts.map(toLegacy), hasNextPage, hasPreviousPage };
}

/**
 * {@linkcode getContactsAsync}, by its paging name.
 *
 * @param contactQuery The query.
 * @returns The page.
 */
export function getPagedContactsAsync(contactQuery: ContactQuery = {}): Promise<ContactResponse> {
  return getContactsAsync(contactQuery);
}

/**
 * One contact.
 *
 * @param id The contact's id.
 * @param fields The fields to read; unset reads every field.
 * @returns The contact, or undefined when there is none with that id.
 */
export async function getContactByIdAsync(
  id: string,
  fields?: FieldType[],
): Promise<ExistingContact | undefined> {
  const p = need("getContactByIdAsync");
  const { contact } = await p.getContactById(
    defined({ id, fields: pluginFields(fields, LEGACY_FIELDS, NAME_FIELDS) }),
  );
  return contact ? toLegacy({ id, ...contact }) : undefined;
}

/**
 * Add a contact to the default container.
 *
 * @param contact The contact.
 * @param _containerId Ignored (the plugin has no containers).
 * @returns The new contact's id.
 */
export async function addContactAsync(
  contact: LegacyContact,
  _containerId?: string,
): Promise<string> {
  const p = need("addContactAsync");
  return (await p.createContact({ contact: fromLegacy(contact) })).id;
}

/**
 * Change a contact: the given fields replace the stored ones, the rest are kept.
 *
 * @param contact The id and the fields to change.
 * @returns The contact's id.
 */
export async function updateContactAsync(
  contact: { id: string } & Partial<ExistingContact>,
): Promise<string> {
  const p = need("updateContactAsync");
  await writeMerged(p, contact.id, fromLegacy(contact));
  return contact.id;
}

/**
 * Delete a contact.
 *
 * @param contactId The contact's id.
 * @returns When it is deleted.
 */
export async function removeContactAsync(contactId: string): Promise<void> {
  await need("removeContactAsync").deleteContactById({ id: contactId });
}

/**
 * Show the system contact form: an existing contact (editable unless `allowsEditing` is
 * `false`), or a new one prefilled from `contact`.
 *
 * @param contactId The contact to show, or null for a new one.
 * @param contact A new contact's prefilled fields.
 * @param formOptions Only `allowsEditing` is honoured.
 * @returns When the form is shown (or, for a new contact, closed).
 */
export async function presentFormAsync(
  contactId?: string | null,
  contact?: LegacyContact | null,
  formOptions: FormOptions = {},
): Promise<void> {
  const p = need("presentFormAsync");
  if (contactId) {
    if (formOptions.allowsEditing === false) await p.displayContactById({ id: contactId });
    else await p.displayUpdateContactById({ id: contactId });
    return;
  }
  await p.displayCreateContact(contact ? { contact: fromLegacy(contact) } : {});
}

/**
 * Let the user pick a contact with the system picker.
 *
 * @returns The contact, or null when the picker was cancelled.
 */
export async function presentContactPickerAsync(): Promise<ExistingContact | null> {
  const { contacts } = await need("presentContactPickerAsync").pickContact({});
  return contacts[0] ? toLegacy(contacts[0]) : null;
}

/**
 * The contact groups, optionally only the one with `groupId` or the ones named `groupName`.
 *
 * @param groupQuery The filter (`containerId` is ignored).
 * @returns The groups.
 */
export async function getGroupsAsync(groupQuery: GroupQuery): Promise<LegacyGroup[]> {
  const { groups } = await need("getGroupsAsync").getGroups();
  return groups
    .filter((g) => groupQuery?.groupId === undefined || g.id === groupQuery.groupId)
    .filter((g) => groupQuery?.groupName === undefined || g.name === groupQuery.groupName)
    .map((g) => ({ id: g.id, name: g.name }));
}

/**
 * Create a contact group.
 *
 * @param name Its name.
 * @param _containerId Ignored (the plugin has no containers).
 * @returns The new group's id.
 */
export async function createGroupAsync(name?: string, _containerId?: string): Promise<string> {
  return (await need("createGroupAsync").createGroup({ group: { name: name ?? "" } })).id;
}

/**
 * Delete a contact group.
 *
 * @param groupId The group's id.
 * @returns When it is deleted.
 */
export async function removeGroupAsync(groupId: string): Promise<void> {
  await need("removeGroupAsync").deleteGroupById({ id: groupId });
}

/**
 * The default container's id. The plugin has no container ids, so this always rejects
 * with `ERR_UNAVAILABLE`.
 *
 * @returns Never resolves.
 */
export async function getDefaultContainerIdAsync(): Promise<string> {
  need("getDefaultContainerIdAsync");
  return await cannot("getDefaultContainerIdAsync", "container ids");
}

/**
 * The containers. The plugin has no container ids, so this always rejects with
 * `ERR_UNAVAILABLE`.
 *
 * @param _containerQuery Ignored.
 * @returns Never resolves.
 */
export async function getContainersAsync(
  _containerQuery: ContainerQuery,
): Promise<LegacyContainer[]> {
  need("getContainersAsync");
  return await cannot("getContainersAsync", "container ids");
}

// ---- the class API --------------------------------------------------------------------------

/** The plugin query of the class API's options. */
function classQuery(options: ContactQueryOptions | undefined, fields?: string[]): Query {
  const sort = options?.sortOrder === ContactsSortOrder.GivenName
    ? "firstName"
    : options?.sortOrder === ContactsSortOrder.FamilyName
    ? "lastName"
    : undefined;
  return { limit: options?.limit, offset: options?.offset, sort, name: options?.name, fields };
}

/** Keep `id` and `fields` of `details` (every field when `fields` is unset). */
function pick<T extends readonly ContactField[]>(
  id: string,
  details: ContactDetails,
  fields: T | undefined,
): PartialContactDetails<T> {
  const out: Record<string, unknown> = { id };
  for (const key of fields ?? Object.keys(details)) {
    out[key] = details[key as keyof ContactDetails];
  }
  return out as PartialContactDetails<T>;
}

/**
 * A contact of the address book, by id. Reads go through the plugin on each call; writes
 * read the stored record, change it and write it back.
 */
export class Contact {
  /** The contact's id. */
  id: string;

  /**
   * A handle on the contact with `id` (nothing is read).
   *
   * @param id The contact's id.
   */
  constructor(id: string) {
    this.id = id;
  }

  /**
   * The contacts, as handles.
   *
   * @param options Limit, offset, sort order and name filter.
   * @returns The contacts.
   */
  static async getAll(options?: ContactQueryOptions): Promise<Contact[]> {
    const p = need("Contact.getAll");
    const { contacts } = await query(p, classQuery(options, NAME_FIELDS));
    return contacts.map((c) => new Contact(c.id ?? ""));
  }

  /**
   * The contacts' details.
   *
   * @param fields The fields to read.
   * @param options Limit, offset, sort order and name filter.
   * @returns Each contact's id and fields.
   */
  static async getAllDetails<T extends readonly ContactField[]>(
    fields: T,
    options?: ContactQueryOptions,
  ): Promise<PartialContactDetails<T>[]> {
    const p = need("Contact.getAllDetails");
    const plugged = pluginFields(fields, DETAIL_FIELDS, NAME_FIELDS);
    const { contacts } = await query(p, classQuery(options, plugged));
    return contacts.map((c) => pick(c.id ?? "", toDetails(c), fields));
  }

  /**
   * Add a contact.
   *
   * @param contact Its fields.
   * @returns A handle on the new contact.
   */
  static async create(contact: CreateContactRecord): Promise<Contact> {
    const { id } = await need("Contact.create").createContact({ contact: fromRecord(contact) });
    return new Contact(id);
  }

  /**
   * Show the system "new contact" form.
   *
   * @param contact Prefilled fields.
   * @param _options Ignored.
   * @returns Whether a contact was created.
   */
  static async presentCreateForm(
    contact?: CreateContactRecord,
    _options?: CreateFormOptions,
  ): Promise<boolean> {
    const p = need("Contact.presentCreateForm");
    const result = await p.displayCreateContact(contact ? { contact: fromRecord(contact) } : {});
    return typeof result?.id === "string" && result.id !== "";
  }

  /**
   * How many contacts there are.
   *
   * @returns The count.
   */
  static async getCount(): Promise<number> {
    return (await need("Contact.getCount").countContacts()).count;
  }

  /**
   * Whether there is any contact.
   *
   * @returns `true` when there is at least one.
   */
  static async hasAny(): Promise<boolean> {
    return (await need("Contact.hasAny").countContacts()).count > 0;
  }

  /**
   * Let the user pick a contact with the system picker.
   *
   * @returns The contact, or null when the picker was cancelled.
   */
  static async presentPicker(): Promise<Contact | null> {
    const { contacts } = await need("Contact.presentPicker").pickContact({});
    return contacts[0]?.id ? new Contact(contacts[0].id) : null;
  }

  /** The stored record through the plugin, or an empty one when it is gone. */
  async #read(name: string, fields?: string[]): Promise<PluginContact> {
    const { contact } = await need(name).getContactById(defined({ id: this.id, fields }));
    return contact ?? {};
  }

  /** Change the stored record (see {@linkcode patch}). */
  async #write(name: string, change: PluginContact, clearBirthday = false): Promise<boolean> {
    await writeMerged(need(name), this.id, change, clearBirthday);
    return true;
  }

  /**
   * Delete the contact.
   *
   * @returns When it is deleted.
   */
  async delete(): Promise<void> {
    await need("Contact.delete").deleteContactById({ id: this.id });
  }

  /**
   * Change some fields; the rest are kept (`null` clears a text field or the birthday).
   *
   * @param contact The change.
   * @returns When it is written.
   */
  async patch(contact: ContactPatch): Promise<void> {
    await this.#write("Contact.patch", fromRecord(contact), contact.birthday === null);
  }

  /**
   * The contact's details.
   *
   * @param fields The fields to read; unset reads every field.
   * @returns The id and the fields.
   */
  async getDetails<T extends readonly ContactField[]>(
    fields?: T,
  ): Promise<PartialContactDetails<T>> {
    const c = await this.#read(
      "Contact.getDetails",
      pluginFields(fields, DETAIL_FIELDS, ["displayName"]),
    );
    return pick(this.id, toDetails(c), fields);
  }

  /** Read the formatted name ("" when there is none). */
  async getFullName(): Promise<string> {
    return displayName(await this.#read("Contact.getFullName", NAME_FIELDS));
  }

  /** Read the email addresses (positional ids). */
  async getEmails(): Promise<ExistingEmail[]> {
    return toDetails(await this.#read("Contact.getEmails", ["emailAddresses"])).emails;
  }

  /** Read the phone numbers (positional ids). */
  async getPhones(): Promise<ExistingPhone[]> {
    return toDetails(await this.#read("Contact.getPhones", ["phoneNumbers"])).phones;
  }

  /** Read the postal addresses (positional ids). */
  async getAddresses(): Promise<ExistingAddress[]> {
    return toDetails(await this.#read("Contact.getAddresses", ["postalAddresses"])).addresses;
  }

  /** Read the URLs (positional ids). */
  async getUrlAddresses(): Promise<ExistingUrlAddress[]> {
    return toDetails(await this.#read("Contact.getUrlAddresses", ["urlAddresses"])).urlAddresses;
  }

  /** Read the given name, or null. */
  async getGivenName(): Promise<string | null> {
    return str((await this.#read("Contact.getGivenName", ["givenName"])).givenName) ?? null;
  }

  /**
   * Set the given name.
   *
   * @param givenName The given name (null clears it).
   * @returns `true` once written.
   */
  setGivenName(givenName: string | null): Promise<boolean> {
    return this.#write("Contact.setGivenName", { givenName: givenName ?? "" });
  }

  /** Read the family name, or null. */
  async getFamilyName(): Promise<string | null> {
    return str((await this.#read("Contact.getFamilyName", ["familyName"])).familyName) ?? null;
  }

  /**
   * Set the family name.
   *
   * @param familyName The family name (null clears it).
   * @returns `true` once written.
   */
  setFamilyName(familyName: string | null): Promise<boolean> {
    return this.#write("Contact.setFamilyName", { familyName: familyName ?? "" });
  }

  /** Read the middle name, or null. */
  async getMiddleName(): Promise<string | null> {
    return str((await this.#read("Contact.getMiddleName", ["middleName"])).middleName) ?? null;
  }

  /**
   * Set the middle name.
   *
   * @param middleName The middle name (null clears it).
   * @returns `true` once written.
   */
  setMiddleName(middleName: string | null): Promise<boolean> {
    return this.#write("Contact.setMiddleName", { middleName: middleName ?? "" });
  }

  /** Read the name prefix, or null. */
  async getPrefix(): Promise<string | null> {
    return str((await this.#read("Contact.getPrefix", ["namePrefix"])).namePrefix) ?? null;
  }

  /**
   * Set the name prefix.
   *
   * @param prefix The name prefix (null clears it).
   * @returns `true` once written.
   */
  setPrefix(prefix: string | null): Promise<boolean> {
    return this.#write("Contact.setPrefix", { namePrefix: prefix ?? "" });
  }

  /** Read the name suffix, or null. */
  async getSuffix(): Promise<string | null> {
    return str((await this.#read("Contact.getSuffix", ["nameSuffix"])).nameSuffix) ?? null;
  }

  /**
   * Set the name suffix.
   *
   * @param suffix The name suffix (null clears it).
   * @returns `true` once written.
   */
  setSuffix(suffix: string | null): Promise<boolean> {
    return this.#write("Contact.setSuffix", { nameSuffix: suffix ?? "" });
  }

  /** Read the company, or null. */
  async getCompany(): Promise<string | null> {
    const c = await this.#read("Contact.getCompany", ["organizationName"]);
    return str(c.organizationName) ?? null;
  }

  /**
   * Set the company.
   *
   * @param company The company (null clears it).
   * @returns `true` once written.
   */
  setCompany(company: string | null): Promise<boolean> {
    return this.#write("Contact.setCompany", { organizationName: company ?? "" });
  }

  /** Read the job title, or null. */
  async getJobTitle(): Promise<string | null> {
    return str((await this.#read("Contact.getJobTitle", ["jobTitle"])).jobTitle) ?? null;
  }

  /**
   * Set the job title.
   *
   * @param jobTitle The job title (null clears it).
   * @returns `true` once written.
   */
  setJobTitle(jobTitle: string | null): Promise<boolean> {
    return this.#write("Contact.setJobTitle", { jobTitle: jobTitle ?? "" });
  }

  /** Read the note, or null. */
  async getNote(): Promise<string | null> {
    return str((await this.#read("Contact.getNote", ["note"])).note) ?? null;
  }

  /**
   * Set the note.
   *
   * @param note The note (null clears it).
   * @returns `true` once written.
   */
  setNote(note: string | null): Promise<boolean> {
    return this.#write("Contact.setNote", { note: note ?? "" });
  }

  /** Read the photo as a `data:` URI, or null. */
  async getImage(): Promise<string | null> {
    return toDetails(await this.#read("Contact.getImage", ["photo"])).image;
  }

  /** Read the birthday (month 1–12), or null. */
  async getBirthday(): Promise<ContactDate | null> {
    return toDetails(await this.#read("Contact.getBirthday", ["birthday"])).birthday ?? null;
  }

  /**
   * Set the birthday.
   *
   * @param birthday The birthday (month 1–12; null clears it where the platform allows).
   * @returns `true` once written.
   */
  setBirthday(birthday: ContactDate | null): Promise<boolean> {
    return birthday === null
      ? this.#write("Contact.setBirthday", {}, true)
      : this.#write("Contact.setBirthday", { birthday: defined({ ...birthday }) });
  }
}

/** A contact group, by id. */
export class Group {
  /** The group's id. */
  readonly id: string;

  /**
   * A handle on the group with `id` (nothing is read).
   *
   * @param id The group's id.
   */
  constructor(id: string) {
    this.id = id;
  }

  /**
   * Create a group.
   *
   * @param name Its name.
   * @param _containerId Ignored (the plugin has no containers).
   * @returns A handle on the new group.
   */
  static async create(name: string, _containerId?: string): Promise<Group> {
    const { id } = await need("Group.create").createGroup({ group: { name } });
    return new Group(id);
  }

  /**
   * The groups.
   *
   * @param _containerId Ignored (the plugin has no containers).
   * @returns Handles on every group.
   */
  static async getAll(_containerId?: string): Promise<Group[]> {
    const { groups } = await need("Group.getAll").getGroups();
    return groups.map((g) => new Group(g.id));
  }

  /** Read the group's name, or null when it is gone. */
  async getName(): Promise<string | null> {
    const { groups } = await need("Group.getName").getGroups();
    return groups.find((g) => g.id === this.id)?.name ?? null;
  }

  /**
   * The group's members.
   *
   * @param options Limit, offset, sort order and name filter.
   * @returns Handles on the members.
   */
  async getContacts(options?: ContactQueryOptions): Promise<Contact[]> {
    const p = need("Group.getContacts");
    const q = { ...classQuery(options, NAME_FIELDS), groupId: this.id };
    return (await query(p, q)).contacts.map((c) => new Contact(c.id ?? ""));
  }

  /**
   * Delete the group (its contacts stay).
   *
   * @returns When it is deleted.
   */
  async delete(): Promise<void> {
    await need("Group.delete").deleteGroupById({ id: this.id });
  }
}

// ---- change events and the access button ---------------------------------------------------

/**
 * Listen for address-book changes. The plugin reports none, so the listener never fires (as
 * in Expo's web build); refresh when the app resumes instead.
 *
 * @param _listener Never called.
 * @returns A subscription whose `remove` does nothing.
 */
export function addContactsChangeListener(_listener: () => void): EventSubscription {
  return subscription(() => {});
}

/** Remove every change listener (they never fire here). */
export function removeAllContactsChangeListeners(): void {}

/** Props of {@linkcode ContactAccessButton} (iOS 18's limited-access button). */
export type ContactAccessButtonProps = {
  /** Text to match contacts not yet shared with the app. */
  query?: string;
  /** What to show under a single match. */
  caption?: "default" | "email" | "phone";
  /** Emails to leave out of the matches. */
  ignoredEmails?: string[];
  /** Phone numbers to leave out of the matches. */
  ignoredPhoneNumbers?: string[];
  /** Tint colour. */
  tintColor?: string;
  /** Background colour. */
  backgroundColor?: string;
  /** Text colour. */
  textColor?: string;
  /** View style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
};

/** The {@linkcode ContactAccessButton} component with its static check. */
export interface ContactAccessButtonComponent {
  /**
   * Render the button: nothing here.
   *
   * @param props The button's props.
   * @returns `null`.
   */
  (props: ContactAccessButtonProps): null;
  /** Whether the button is available: never here (the plugin has no SwiftUI button). */
  isAvailable(): boolean;
}

/**
 * iOS 18's `ContactAccessButton`. The plugin does not provide it, so it renders nothing and
 * `isAvailable()` is `false`, as on Android and the web in Expo.
 */
export const ContactAccessButton: ContactAccessButtonComponent = /* @__PURE__ */ Object.assign(
  (_props: ContactAccessButtonProps): null => null,
  { isAvailable: (): boolean => false },
);
