import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import type { AuthContext } from '@botmem/connector-sdk';

// Default Telegram API credentials (public test app — users can override)
const DEFAULT_API_ID = 2040;
const DEFAULT_API_HASH = 'b18441a1ff607e10a989891a5462e627';

export interface TelegramAuthConfig {
  phone: string;
  apiId?: string | number;
  apiHash?: string;
}

export interface PendingAuth {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  wsChannel: string;
}

const pendingAuths = new Map<string, PendingAuth>();

export function getPendingAuth(wsChannel: string): PendingAuth | undefined {
  return pendingAuths.get(wsChannel);
}

export function removePendingAuth(wsChannel: string): void {
  pendingAuths.delete(wsChannel);
}

/**
 * Step 1: Send verification code to the user's Telegram phone.
 * Returns the wsChannel to use for subsequent steps.
 */
export async function sendCode(
  config: TelegramAuthConfig,
  wsChannel: string,
): Promise<{ phoneCodeHash: string }> {
  const apiId = Number(config.apiId) || DEFAULT_API_ID;
  const apiHash = config.apiHash || DEFAULT_API_HASH;
  const session = new StringSession('');

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
    deviceModel: 'Botmem',
    systemVersion: 'macOS',
    appVersion: '1.0.0',
  });

  await client.connect();

  const result = await client.sendCode({ apiId, apiHash }, config.phone);

  const pending: PendingAuth = {
    client,
    phone: config.phone,
    phoneCodeHash: result.phoneCodeHash,
    wsChannel,
  };
  pendingAuths.set(wsChannel, pending);

  // Auto-cleanup after 5 minutes
  setTimeout(() => {
    const p = pendingAuths.get(wsChannel);
    if (p) {
      pendingAuths.delete(wsChannel);
      p.client.disconnect().catch(() => {});
    }
  }, 5 * 60_000);

  return { phoneCodeHash: result.phoneCodeHash };
}

/**
 * Step 2: Verify the code the user received.
 * Returns auth context on success, or throws specific errors.
 */
export async function verifyCode(
  wsChannel: string,
  code: string,
): Promise<{ auth: AuthContext; need2fa: false } | { need2fa: true }> {
  const pending = pendingAuths.get(wsChannel);
  if (!pending) throw new Error('No pending auth session — please restart');

  try {
    await pending.client.invoke(
      new (await import('telegram/tl/index.js')).Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      }),
    );

    const session = pending.client.session.save() as unknown as string;
    const me = await pending.client.getMe();
    const auth: AuthContext = {
      identifier: pending.phone,
      raw: {
        session,
        phone: pending.phone,
        userId: me?.id?.toString(),
        username: (me as unknown as Record<string, unknown>)?.username,
        firstName: (me as unknown as Record<string, unknown>)?.firstName,
      },
    };

    pendingAuths.delete(wsChannel);
    return { auth, need2fa: false };
  } catch (err: unknown) {
    const errName = (err as { errorMessage?: string })?.errorMessage || '';

    if (errName === 'SESSION_PASSWORD_NEEDED') {
      return { need2fa: true };
    }
    if (errName === 'PHONE_CODE_INVALID') {
      throw new Error('Invalid verification code');
    }
    if (errName === 'PHONE_CODE_EXPIRED') {
      throw new Error('Code expired — please request a new one');
    }
    throw err;
  }
}

/**
 * Step 3 (optional): Provide 2FA password.
 */
export async function verify2fa(wsChannel: string, password: string): Promise<AuthContext> {
  const pending = pendingAuths.get(wsChannel);
  if (!pending) throw new Error('No pending auth session — please restart');

  try {
    await pending.client.invoke(
      new (await import('telegram/tl/index.js')).Api.auth.CheckPassword({
        password: await pending.client.computePasswordSRP(password),
      } as Record<string, unknown>),
    );

    const session = pending.client.session.save() as unknown as string;
    const me = await pending.client.getMe();
    const auth: AuthContext = {
      identifier: pending.phone,
      raw: {
        session,
        phone: pending.phone,
        userId: me?.id?.toString(),
        username: (me as unknown as Record<string, unknown>)?.username,
        firstName: (me as unknown as Record<string, unknown>)?.firstName,
      },
    };

    pendingAuths.delete(wsChannel);
    return auth;
  } catch (err: unknown) {
    const errName = (err as { errorMessage?: string })?.errorMessage || '';
    if (errName === 'PASSWORD_HASH_INVALID') {
      throw new Error('Wrong 2FA password');
    }
    throw err;
  }
}

/**
 * Create a client from a saved session string.
 */
export function createClientFromSession(
  sessionStr: string,
  apiId?: number,
  apiHash?: string,
): TelegramClient {
  const session = new StringSession(sessionStr);
  return new TelegramClient(session, apiId || DEFAULT_API_ID, apiHash || DEFAULT_API_HASH, {
    connectionRetries: 3,
    deviceModel: 'Botmem',
    systemVersion: 'macOS',
    appVersion: '1.0.0',
  });
}

/**
 * Compute 2FA password SRP using the client's helper (typed loosely because GramJS types vary).
 */
TelegramClient.prototype.computePasswordSRP = async function (password: string) {
  const { Api } = await import('telegram/tl/index.js');
  const { computeCheck } = await import('telegram/Password.js');
  const accountPassword = await this.invoke(new Api.account.GetPassword());
  return computeCheck(accountPassword, password);
};

declare module 'telegram' {
  interface TelegramClient {
    computePasswordSRP(password: string): Promise<unknown>;
  }
}
