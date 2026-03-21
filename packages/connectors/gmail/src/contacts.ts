import { google } from 'googleapis';
import type { SyncContext, ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';
import { createOAuth2Client } from './oauth.js';

const PAGE_SIZE = 1000; // People API max

export async function syncContacts(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
  emitProgress: (event: ProgressEvent) => void,
): Promise<{ processed: number }> {
  const clientId = ctx.auth.raw?.clientId as string | undefined;
  const clientSecret = ctx.auth.raw?.clientSecret as string | undefined;
  const redirectUri =
    (ctx.auth.raw?.redirectUri as string | undefined) ||
    'http://localhost:12412/api/auth/gmail/callback';
  const auth =
    clientId && clientSecret
      ? createOAuth2Client(clientId, clientSecret, redirectUri)
      : new google.auth.OAuth2();
  auth.setCredentials({
    access_token: ctx.auth.accessToken,
    refresh_token: ctx.auth.refreshToken,
  });

  const people = google.people({ version: 'v1', auth });
  let processed = 0;
  let pageToken: string | undefined;

  ctx.logger.info('Starting Google Contacts sync');

  // Get total count
  let total = 0;
  try {
    const totalRes = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1,
      personFields: 'names',
    });
    total = totalRes.data.totalPeople || 0;
    ctx.logger.info(
      `Total contacts: ${total}, first page connections: ${totalRes.data.connections?.length || 0}`,
    );
  } catch (err: unknown) {
    ctx.logger.warn(
      `Failed to get contacts count: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  emitProgress({ processed: 0, total });

  do {
    if (ctx.signal.aborted) break;

    let res;
    try {
      res = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: PAGE_SIZE,
        pageToken,
        personFields:
          'names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,urls,relations,events,occupations,nicknames,photos,sipAddresses,imClients,userDefined,memberships,externalIds,interests,genders',
      });
    } catch (err: unknown) {
      ctx.logger.error(`Contacts list failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    const connections = res.data.connections || [];
    ctx.logger.info(
      `Contacts page: ${connections.length} connections, nextPage: ${res.data.nextPageToken ? 'yes' : 'no'}`,
    );

    for (const person of connections) {
      if (ctx.signal.aborted) break;

      const name = person.names?.[0]?.displayName || 'Unknown';
      const givenName = person.names?.[0]?.givenName;
      const familyName = person.names?.[0]?.familyName;
      const emails = (person.emailAddresses || []).map((e) => e.value).filter(Boolean) as string[];
      const phones = (person.phoneNumbers || [])
        .map((p) => `${p.value} (${p.type || 'other'})`)
        .filter(Boolean);
      const orgs = (person.organizations || [])
        .map((o) => ({
          name: o.name || undefined,
          title: o.title || undefined,
          department: o.department || undefined,
        }))
        .filter((o) => o.name || o.title);
      const orgDisplay = orgs
        .map((o) => [o.name, o.title, o.department].filter(Boolean).join(' — '))
        .filter(Boolean);
      const addresses = (person.addresses || [])
        .map((a) => a.formattedValue)
        .filter(Boolean) as string[];
      const birthday = person.birthdays?.[0]?.date;
      const birthdayStr = birthday
        ? `${birthday.year || '????'}-${String(birthday.month || 1).padStart(2, '0')}-${String(birthday.day || 1).padStart(2, '0')}`
        : undefined;
      const bio = person.biographies?.[0]?.value;
      const urls = (person.urls || []).map((u) => u.value).filter(Boolean) as string[];
      const relations = (person.relations || [])
        .map((r) => `${r.person} (${r.type || 'other'})`)
        .filter(Boolean);
      const nicknames = (person.nicknames || []).map((n) => n.value).filter(Boolean) as string[];
      const photoUrl = person.photos?.[0]?.url || undefined;
      const sipAddresses = (person.sipAddresses || [])
        .map((s) => s.value)
        .filter(Boolean) as string[];
      const imClients = (person.imClients || [])
        .map((im) => `${im.username} (${im.protocol || im.type || 'other'})`)
        .filter(Boolean);
      const occupations = (person.occupations || [])
        .map((o) => o.value)
        .filter(Boolean) as string[];
      const interests = (person.interests || []).map((i) => i.value).filter(Boolean) as string[];
      const gender = person.genders?.[0]?.value || undefined;
      const externalIds = (person.externalIds || [])
        .map((e) => `${e.value} (${e.type || 'other'})`)
        .filter(Boolean);
      const userDefined = (person.userDefined || [])
        .map((u) => `${u.key}: ${u.value}`)
        .filter(Boolean);
      const events = (person.events || [])
        .map((e) => {
          const d = e.date;
          const dateStr = d
            ? `${d.year || '????'}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}`
            : '';
          return `${e.type || 'other'}: ${dateStr}`;
        })
        .filter(Boolean);

      const textParts = [`Contact: ${name}`];
      if (nicknames.length) textParts.push(`Nicknames: ${nicknames.join(', ')}`);
      if (emails.length) textParts.push(`Email: ${emails.join(', ')}`);
      if (phones.length) textParts.push(`Phone: ${phones.join(', ')}`);
      if (orgDisplay.length) textParts.push(`Organization: ${orgDisplay.join('; ')}`);
      if (occupations.length) textParts.push(`Occupation: ${occupations.join(', ')}`);
      if (addresses.length) textParts.push(`Address: ${addresses.join('; ')}`);
      if (birthdayStr) textParts.push(`Birthday: ${birthdayStr}`);
      if (bio) textParts.push(`Bio: ${bio}`);
      if (relations.length) textParts.push(`Relations: ${relations.join(', ')}`);
      if (sipAddresses.length) textParts.push(`SIP: ${sipAddresses.join(', ')}`);
      if (imClients.length) textParts.push(`IM: ${imClients.join(', ')}`);
      if (interests.length) textParts.push(`Interests: ${interests.join(', ')}`);
      if (gender) textParts.push(`Gender: ${gender}`);
      if (events.length) textParts.push(`Events: ${events.join(', ')}`);
      if (externalIds.length) textParts.push(`External IDs: ${externalIds.join(', ')}`);
      if (userDefined.length) textParts.push(`Custom: ${userDefined.join(', ')}`);

      emit({
        sourceType: 'contact',
        sourceId: person.resourceName || `contact-${processed}`,
        timestamp: person.metadata?.sources?.[0]?.updateTime || new Date().toISOString(),
        content: {
          text: textParts.join('\n'),
          participants: [name, ...emails],
          metadata: {
            type: 'contact',
            name,
            givenName,
            familyName,
            emails,
            phones,
            organizations: orgs,
            addresses,
            birthday: birthdayStr,
            bio,
            urls,
            relations,
            nicknames,
            photoUrl,
            sipAddresses,
            imClients,
            occupations,
            interests,
            gender,
            externalIds,
            userDefined,
            events,
          },
        },
      });

      processed++;
    }

    emitProgress({ processed, total });
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  ctx.logger.info(`Synced ${processed} contacts`);
  return { processed };
}
