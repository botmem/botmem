import type { ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';
import type { GraphClient } from './graph-client.js';

interface GraphContact {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: Array<{ name?: string; address?: string }>;
  mobilePhone?: string;
  businessPhones?: string[];
  homePhones?: string[];
  companyName?: string;
  jobTitle?: string;
  birthday?: string;
  personalNotes?: string;
  homeAddress?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    countryOrRegion?: string;
  };
  businessAddress?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    countryOrRegion?: string;
  };
  imAddresses?: string[];
  nickName?: string;
  lastModifiedDateTime?: string;
}

interface GraphContactsResponse {
  value: GraphContact[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

const CONTACTS_SELECT = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'emailAddresses',
  'mobilePhone',
  'businessPhones',
  'homePhones',
  'companyName',
  'jobTitle',
  'birthday',
  'personalNotes',
  'homeAddress',
  'businessAddress',
  'imAddresses',
  'nickName',
  'lastModifiedDateTime',
].join(',');

export async function syncOutlookContacts(
  client: GraphClient,
  emitData: (event: ConnectorDataEvent) => boolean,
  emitProgress: (event: ProgressEvent) => boolean,
  signal?: AbortSignal,
): Promise<{ processed: number }> {
  let processed = 0;
  let url: string | null = `/me/contacts?$top=100&$select=${CONTACTS_SELECT}`;
  const seenUrls = new Set<string>();
  const seenContactIds = new Set<string>();

  while (url) {
    if (signal?.aborted) break;

    // Guard against pagination loops — if we've seen this URL before, stop
    if (seenUrls.has(url)) break;
    seenUrls.add(url);

    const response: GraphContactsResponse = await client.get<GraphContactsResponse>(url);

    // Empty page means we're done
    if (!response.value?.length) break;

    let allDuplicates = true;
    for (const contact of response.value) {
      if (signal?.aborted) break;

      // Skip duplicate contacts (Graph API can return the same contact in loops)
      if (seenContactIds.has(contact.id)) continue;
      seenContactIds.add(contact.id);
      allDuplicates = false;

      const event = contactToEvent(contact);
      if (event) {
        const shouldContinue = emitData(event);
        if (!shouldContinue) return { processed };
        processed++;
      }
    }

    // If every contact on this page was already seen, the API is looping — stop
    if (allDuplicates && response.value.length > 0) break;

    emitProgress({ processed });
    url = response['@odata.nextLink'] || null;
  }

  return { processed };
}

function contactToEvent(contact: GraphContact): ConnectorDataEvent | null {
  const name =
    contact.displayName || [contact.givenName, contact.surname].filter(Boolean).join(' ');
  if (!name && !contact.emailAddresses?.length) return null;

  // Collect all emails
  const emails = (contact.emailAddresses || [])
    .map((e) => e.address)
    .filter((e): e is string => !!e);

  // Collect all phones
  const phones: string[] = [];
  if (contact.mobilePhone) phones.push(contact.mobilePhone);
  if (contact.businessPhones) phones.push(...contact.businessPhones);
  if (contact.homePhones) phones.push(...contact.homePhones);

  // Build participants array — name + all emails (for contact resolution)
  const participants = [name, ...emails].filter((p): p is string => !!p);

  // Build a text summary for embedding
  const textParts: string[] = [];
  if (name) textParts.push(`Contact: ${name}`);
  if (contact.jobTitle && contact.companyName) {
    textParts.push(`${contact.jobTitle} at ${contact.companyName}`);
  } else if (contact.companyName) {
    textParts.push(contact.companyName);
  } else if (contact.jobTitle) {
    textParts.push(contact.jobTitle);
  }
  if (emails.length) textParts.push(`Email: ${emails.join(', ')}`);
  if (phones.length) textParts.push(`Phone: ${phones.join(', ')}`);
  if (contact.personalNotes) textParts.push(contact.personalNotes);

  // Build organizations array for metadata
  const organizations: Array<{ name?: string; title?: string }> = [];
  if (contact.companyName || contact.jobTitle) {
    organizations.push({ name: contact.companyName, title: contact.jobTitle });
  }

  return {
    sourceType: 'contact',
    sourceId: `outlook-contact-${contact.id}`,
    timestamp: contact.lastModifiedDateTime || new Date().toISOString(),
    content: {
      text: textParts.join('\n'),
      participants,
      metadata: {
        type: 'contact',
        name: name || undefined,
        givenName: contact.givenName,
        familyName: contact.surname,
        emails,
        phones,
        organizations,
        nicknames: contact.nickName ? [contact.nickName] : [],
        addresses: [contact.homeAddress, contact.businessAddress].filter(Boolean),
        birthday: contact.birthday,
        bio: contact.personalNotes,
        imClients: contact.imAddresses,
      },
    },
  };
}
