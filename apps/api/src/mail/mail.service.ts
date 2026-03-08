import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpPort === 465,
        auth: {
          user: this.config.smtpUser,
          pass: this.config.smtpPass,
        },
      });
    }
    return this.transporter;
  }

  async sendResetEmail(to: string, resetUrl: string): Promise<void> {
    if (!this.config.smtpConfigured) {
      console.log(`[MAIL] Password reset link for ${to}: ${resetUrl}`);
      return;
    }

    try {
      const transporter = this.getTransporter();
      await transporter.sendMail({
        from: this.config.smtpFrom,
        to,
        subject: 'Botmem - Password Reset',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Password Reset</h2>
            <p>You requested a password reset for your Botmem account.</p>
            <p>
              <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px;">
                Reset Password
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">
              This link expires in 1 hour. If you did not request this reset, you can safely ignore this email.
            </p>
          </div>
        `,
      });
      this.logger.log(`Password reset email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${to}`, (error as Error).stack);
      // Do not throw -- reset endpoint should not fail because email fails
    }
  }
}
