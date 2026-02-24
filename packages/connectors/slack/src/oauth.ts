const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const SCOPES = 'channels:history,channels:read,users:read';

export function getSlackAuthUrl(clientId: string, redirectUri: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
  });
  return `${SLACK_AUTH_URL}?${params}`;
}

export async function exchangeSlackCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
) {
  const res = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Slack OAuth error: ${data.error}`);
  return data;
}
