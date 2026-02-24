import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

export function createOAuth2Client(clientId: string, clientSecret: string, redirectUri: string) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(client: ReturnType<typeof createOAuth2Client>) {
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function exchangeCode(client: ReturnType<typeof createOAuth2Client>, code: string) {
  const { tokens } = await client.getToken(code);
  return tokens;
}
