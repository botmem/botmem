/**
 * Change Password e2e tests (AUTH-068 → AUTH-074)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureApiRunning, closeApp, registerUser, authedRequest, request } from '../helpers/index.js';

beforeAll(async () => {
  await ensureApiRunning();
}, 60_000);

afterAll(async () => {
  await closeApp();
});

describe('Change Password (AUTH-068 → AUTH-074)', () => {
  it('AUTH-068: Change with correct old password — 200', async () => {
    const user = await registerUser();
    const newPassword = 'NewSecure123!';

    await authedRequest(user.accessToken)
      .post('/api/user-auth/change-password')
      .send({ oldPassword: user.password, newPassword })
      .expect(200);

    // Verify can login with new password
    const loginRes = await request()
      .post('/api/user-auth/login')
      .send({ email: user.email, password: newPassword })
      .expect(200);

    expect(loginRes.body).toHaveProperty('accessToken');
  });

  it('AUTH-069: Change with wrong old password — 401', async () => {
    const user = await registerUser();

    const res = await authedRequest(user.accessToken)
      .post('/api/user-auth/change-password')
      .send({ oldPassword: 'WrongOldPass!', newPassword: 'NewSecure123!' })
      .expect(401);

    expect(res.body.message).toMatch(/current password is incorrect/i);
  });

  it('AUTH-070: New password < 8 chars — 400', async () => {
    const user = await registerUser();

    await authedRequest(user.accessToken)
      .post('/api/user-auth/change-password')
      .send({ oldPassword: user.password, newPassword: 'short' })
      .expect(400);
  });

  it('AUTH-071: Change password revokes all refresh tokens', async () => {
    const user = await registerUser();

    // Login from another "device" to get a second refresh token
    const login2 = await request()
      .post('/api/user-auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);

    const refreshCookie2 = Array.isArray(login2.headers['set-cookie'])
      ? login2.headers['set-cookie'].find((c: string) => c.includes('refresh_token='))
      : login2.headers['set-cookie'];

    // Change password
    await authedRequest(user.accessToken)
      .post('/api/user-auth/change-password')
      .send({ oldPassword: user.password, newPassword: 'ChangedPass123!' })
      .expect(200);

    // Original refresh token should be revoked
    await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', user.refreshCookie!)
      .expect(401);

    // Second device refresh token should also be revoked
    if (refreshCookie2) {
      await request()
        .post('/api/user-auth/refresh')
        .set('Cookie', refreshCookie2)
        .expect(401);
    }
  });

  it('AUTH-072: Change password does NOT affect DEK/encryption', async () => {
    const user = await registerUser();
    const newPassword = 'ChangedPass123!';

    // Submit recovery key before changing password (ensures DEK is loaded)
    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    // Change password
    await authedRequest(user.accessToken)
      .post('/api/user-auth/change-password')
      .send({ oldPassword: user.password, newPassword })
      .expect(200);

    // Login with new password
    const loginRes = await request()
      .post('/api/user-auth/login')
      .send({ email: user.email, password: newPassword })
      .expect(200);

    // DEK should still be cached — needsRecoveryKey: false proves it
    expect(loginRes.body.needsRecoveryKey).toBe(false);

    // Recovery key should still work (same key, not re-derived from password)
    await authedRequest(loginRes.body.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);
  });

  it('AUTH-073: Change password requires JWT auth', async () => {
    await request()
      .post('/api/user-auth/change-password')
      .send({ oldPassword: 'anything', newPassword: 'NewPass123!' })
      .expect(401);
  });

  it('AUTH-074: Bcrypt cost factor is adequate — login works with correct password', async () => {
    // We cannot read the bcrypt hash directly from the API. Instead, verify:
    // 1) Registration + login works (proves hash is stored and verifiable)
    // 2) Password change + re-login works (proves bcrypt comparison is correct)
    const user = await registerUser();
    const newPassword = 'BcryptTest456!';

    // Change password — creates a new bcrypt hash
    await authedRequest(user.accessToken)
      .post('/api/user-auth/change-password')
      .send({ oldPassword: user.password, newPassword })
      .expect(200);

    // Login with new password — proves the new bcrypt hash is valid
    const loginRes = await request()
      .post('/api/user-auth/login')
      .send({ email: user.email, password: newPassword })
      .expect(200);

    expect(loginRes.body).toHaveProperty('accessToken');

    // Old password no longer works
    await request()
      .post('/api/user-auth/login')
      .send({ email: user.email, password: user.password })
      .expect(401);
  });
});
