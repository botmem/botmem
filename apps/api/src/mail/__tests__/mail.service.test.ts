import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test-id' });
  const mockCreateTransport = vi.fn().mockReturnValue({ sendMail: mockSendMail });
  return { mockSendMail, mockCreateTransport };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

import { MailService } from '../mail.service';

describe('MailService', () => {
  let mailService: MailService;

  describe('when SMTP is NOT configured', () => {
    beforeEach(() => {
      const configService = {
        smtpConfigured: false,
        smtpHost: '',
        smtpPort: 587,
        smtpUser: '',
        smtpPass: '',
        smtpFrom: 'noreply@botmem.xyz',
      } as any;
      mailService = new MailService(configService);
      mockSendMail.mockClear();
      mockCreateTransport.mockClear();
    });

    it('should log reset URL via NestJS Logger instead of sending email', async () => {
      const loggerSpy = vi.spyOn((mailService as any).logger, 'log').mockImplementation(() => {});

      await mailService.sendResetEmail('user@example.com', 'https://botmem.xyz/reset?token=abc');

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('user@example.com'));
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://botmem.xyz/reset?token=abc'),
      );
      expect(mockSendMail).not.toHaveBeenCalled();

      loggerSpy.mockRestore();
    });
  });

  describe('when SMTP IS configured', () => {
    beforeEach(() => {
      const configService = {
        smtpConfigured: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user@example.com',
        smtpPass: 'password',
        smtpFrom: 'noreply@botmem.xyz',
      } as any;
      mailService = new MailService(configService);
      mockSendMail.mockClear();
      mockCreateTransport.mockClear();
    });

    it('should send email via nodemailer transport', async () => {
      await mailService.sendResetEmail(
        'recipient@example.com',
        'https://botmem.xyz/reset?token=xyz',
      );

      expect(mockCreateTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: 'user@example.com',
          pass: 'password',
        },
      });
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'noreply@botmem.xyz',
          to: 'recipient@example.com',
          subject: 'Botmem - Password Reset',
        }),
      );
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      const configService = {
        smtpConfigured: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user@example.com',
        smtpPass: 'password',
        smtpFrom: 'noreply@botmem.xyz',
      } as any;
      mailService = new MailService(configService);
      mockSendMail.mockClear();
      mockCreateTransport.mockClear();
    });

    it('should not throw when transport fails', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));

      await expect(
        mailService.sendResetEmail('user@example.com', 'https://botmem.xyz/reset?token=fail'),
      ).resolves.toBeUndefined();
    });
  });
});
