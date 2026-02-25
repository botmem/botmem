import { describe, it, expect } from 'vitest';
import { buildSlackIdentifiers } from '../embed.processor';

describe('buildSlackIdentifiers', () => {
  it('should include name, email, phone, and slack_id when profile has all fields', () => {
    const profiles = {
      U123ABC: {
        name: 'amressam',
        realName: 'Amr Essam',
        email: 'amr@example.com',
        phone: '+201234567890',
        title: 'Engineer',
        avatarUrl: 'https://example.com/avatar.png',
      },
    };

    const identifiers = buildSlackIdentifiers('U123ABC', profiles);

    expect(identifiers).toEqual([
      { type: 'name', value: 'Amr Essam', connectorType: 'slack' },
      { type: 'email', value: 'amr@example.com', connectorType: 'slack' },
      { type: 'phone', value: '+201234567890', connectorType: 'slack' },
      { type: 'slack_id', value: 'U123ABC', connectorType: 'slack' },
    ]);
  });

  it('should use username as name when realName is missing', () => {
    const profiles = {
      U456DEF: {
        name: 'johndoe',
        email: 'john@example.com',
      },
    };

    const identifiers = buildSlackIdentifiers('U456DEF', profiles);

    expect(identifiers).toEqual([
      { type: 'name', value: 'U456DEF', connectorType: 'slack' },
      { type: 'email', value: 'john@example.com', connectorType: 'slack' },
      { type: 'slack_id', value: 'U456DEF', connectorType: 'slack' },
    ]);
  });

  it('should only include name and slack_id when profile has no email or phone', () => {
    const profiles = {
      U789GHI: {
        name: 'janedoe',
        realName: 'Jane Doe',
      },
    };

    const identifiers = buildSlackIdentifiers('U789GHI', profiles);

    expect(identifiers).toEqual([
      { type: 'name', value: 'Jane Doe', connectorType: 'slack' },
      { type: 'slack_id', value: 'U789GHI', connectorType: 'slack' },
    ]);
  });

  it('should return only slack_id when no profile is available', () => {
    const profiles = {};

    const identifiers = buildSlackIdentifiers('U000UNKNOWN', profiles);

    expect(identifiers).toEqual([
      { type: 'slack_id', value: 'U000UNKNOWN', connectorType: 'slack' },
    ]);
  });

  it('should return only slack_id when profiles is undefined', () => {
    const identifiers = buildSlackIdentifiers('U000UNKNOWN', undefined);

    expect(identifiers).toEqual([
      { type: 'slack_id', value: 'U000UNKNOWN', connectorType: 'slack' },
    ]);
  });
});
