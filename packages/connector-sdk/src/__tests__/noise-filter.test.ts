import { describe, it, expect } from 'vitest';
import {
  isNoise,
  isOtp,
  isAutomatedSender,
  isMarketingEmail,
  detectNoiseReason,
} from '../noise-filter.js';

describe('isOtp', () => {
  it('returns false for empty/falsy text', () => {
    expect(isOtp('')).toBe(false);
    expect(isOtp(undefined as unknown as string)).toBe(false);
  });

  it('detects "Your code is 123456" pattern', () => {
    expect(isOtp('Your code is 123456')).toBe(true);
    expect(isOtp('verification code: 987654')).toBe(true);
    expect(isOtp('Your OTP is 4321')).toBe(true);
    expect(isOtp('confirm pin 12345678')).toBe(true);
    expect(isOtp('Please verify with 5555')).toBe(true);
    expect(isOtp('Your confirmation code is 999999')).toBe(true);
  });

  it('detects "123456 is your verification code" pattern', () => {
    expect(isOtp('123456 is your verification code')).toBe(true);
    expect(isOtp('5678 is your OTP')).toBe(true);
    expect(isOtp('9999 is your pin')).toBe(true);
  });

  it('returns false for normal messages', () => {
    expect(isOtp('Hey, how are you?')).toBe(false);
    expect(isOtp('Meeting at 3pm tomorrow')).toBe(false);
    expect(isOtp('The number 123456 was interesting')).toBe(false);
  });
});

describe('isAutomatedSender', () => {
  it('returns false when no sender fields exist', () => {
    expect(isAutomatedSender({})).toBe(false);
    expect(isAutomatedSender({ subject: 'hello' })).toBe(false);
  });

  it('returns false for non-string sender fields', () => {
    expect(isAutomatedSender({ from: 42, sender: null })).toBe(false);
  });

  it('detects noreply senders', () => {
    expect(isAutomatedSender({ from: 'noreply@example.com' })).toBe(true);
    expect(isAutomatedSender({ sender: 'no-reply@company.org' })).toBe(true);
    expect(isAutomatedSender({ senderEmail: 'NOREPLY@BIG.COM' })).toBe(true);
  });

  it('detects notification senders', () => {
    expect(isAutomatedSender({ from: 'notifications@github.com' })).toBe(true);
    expect(isAutomatedSender({ from: 'notification@service.io' })).toBe(true);
  });

  it('detects mailer-daemon and postmaster', () => {
    expect(isAutomatedSender({ from: 'mailer-daemon@mail.com' })).toBe(true);
    expect(isAutomatedSender({ from: 'postmaster@example.com' })).toBe(true);
  });

  it('detects do-not-reply and doNotReply', () => {
    expect(isAutomatedSender({ from: 'do-not-reply@x.com' })).toBe(true);
    expect(isAutomatedSender({ from: 'doNotReply@x.com' })).toBe(true);
  });

  it('detects automatic-reply and bounce senders', () => {
    expect(isAutomatedSender({ from: 'automatic-reply@corp.com' })).toBe(true);
    expect(isAutomatedSender({ from: 'bounce@mail.com' })).toBe(true);
    expect(isAutomatedSender({ from: 'bounces@mail.com' })).toBe(true);
  });

  it('returns false for real senders', () => {
    expect(isAutomatedSender({ from: 'alice@example.com' })).toBe(false);
    expect(isAutomatedSender({ sender: 'Bob Smith' })).toBe(false);
  });
});

describe('isMarketingEmail', () => {
  it('returns false for empty text', () => {
    expect(isMarketingEmail('', {})).toBe(false);
  });

  it('returns false when no unsubscribe keyword', () => {
    expect(isMarketingEmail('Check out our sale!', {})).toBe(false);
  });

  it('returns true for text with unsubscribe and no receipt patterns', () => {
    expect(isMarketingEmail('Big sale! Click to unsubscribe', {})).toBe(true);
  });

  it('returns false for receipts even with unsubscribe', () => {
    expect(isMarketingEmail('Order #12345 confirmation. Unsubscribe here.', {})).toBe(false);
    expect(isMarketingEmail('Shipping confirmation for your item. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Your tracking number is ABC123. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Here is your receipt. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Invoice for March. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Delivery confirmation. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Your order has shipped. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Purchase confirmation #99. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Shipping update for your package. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Shipping notification: item en route. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Delivery update: arriving tomorrow. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Delivery notification sent. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Tracking info for your parcel. Unsubscribe', {})).toBe(false);
    expect(isMarketingEmail('Tracking # available. Unsubscribe', {})).toBe(false);
  });

  it('returns true for promo labels with unsubscribe', () => {
    expect(
      isMarketingEmail('Weekly deals! Unsubscribe', {
        labels: ['CATEGORY_PROMOTIONS'],
      }),
    ).toBe(true);
  });

  it('returns true for social labels with unsubscribe', () => {
    expect(
      isMarketingEmail('Someone liked your post. Unsubscribe', {
        labels: ['CATEGORY_SOCIAL'],
      }),
    ).toBe(true);
  });

  it('returns true for unsubscribe text with non-matching labels', () => {
    expect(
      isMarketingEmail('Newsletter content. Unsubscribe', {
        labels: ['INBOX', 'IMPORTANT'],
      }),
    ).toBe(true);
  });

  it('handles labels that is not an array', () => {
    expect(isMarketingEmail('Promo stuff. Unsubscribe', { labels: 'not-array' })).toBe(true);
  });
});

describe('isNoise', () => {
  it('returns true for OTP messages', () => {
    expect(isNoise('Your code is 123456', {})).toBe(true);
  });

  it('returns true for automated senders', () => {
    expect(isNoise('Hello', { from: 'noreply@example.com' })).toBe(true);
  });

  it('returns true for marketing emails', () => {
    expect(isNoise('Sale! Unsubscribe here', {})).toBe(true);
  });

  it('returns false for normal content', () => {
    expect(isNoise('Hey, lunch tomorrow?', { from: 'alice@example.com' })).toBe(false);
  });
});

describe('detectNoiseReason', () => {
  it('returns otp for OTP messages', () => {
    expect(detectNoiseReason('Your code is 123456', {})).toBe('otp');
  });

  it('returns automated_sender for automated senders', () => {
    expect(detectNoiseReason('Hello', { from: 'noreply@x.com' })).toBe('automated_sender');
  });

  it('returns marketing for marketing emails', () => {
    expect(detectNoiseReason('Big deals! Unsubscribe', {})).toBe('marketing');
  });

  it('returns null for non-noise content', () => {
    expect(detectNoiseReason('Regular message', { from: 'friend@mail.com' })).toBeNull();
  });
});
