import { Injectable, Logger } from '@nestjs/common';
import { convert } from 'html-to-text';

const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const MAX_CONTENT_LENGTH = 10_000;
const TRUNCATION_SUFFIX = '\n\n---\n*[Truncated]*';

@Injectable()
export class ContentCleaner {
  private readonly logger = new Logger(ContentCleaner.name);

  /**
   * Parse a file buffer to plain text based on MIME type.
   * Handles PDF, Word docs, Excel spreadsheets, and plain text files.
   */
  async parseFile(buffer: Buffer, mimeType: string, fileName?: string): Promise<string> {
    const mime = mimeType.toLowerCase();
    const ext = (fileName || '').toLowerCase().split('.').pop() || '';
    const header = fileName ? `# ${fileName}` : '';

    try {
      if (mime === 'application/pdf' || ext === 'pdf') {
        const pdfParseModule = await import('pdf-parse');
        const pdfParse = pdfParseModule.default || pdfParseModule;
        const data = await (pdfParse as unknown as (buf: Buffer) => Promise<{ text?: string }>)(
          buffer,
        );
        const text = data.text?.trim();
        if (!text) return '';
        let content = header ? `${header}\n\n${text}` : text;
        if (content.length > MAX_CONTENT_LENGTH) {
          content =
            content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
        }
        return content;
      }

      if (
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        ext === 'docx'
      ) {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        const text = result.value?.trim();
        if (!text) return '';
        let content = header ? `${header}\n\n${text}` : text;
        if (content.length > MAX_CONTENT_LENGTH) {
          content =
            content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
        }
        return content;
      }

      if (
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'application/vnd.ms-excel' ||
        mime === 'text/csv' ||
        ext === 'xlsx' ||
        ext === 'xls' ||
        ext === 'csv'
      ) {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sections: string[] = [];

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (!csv.trim()) continue;
          const lines = csv.split('\n').filter((l: string) => l.trim());
          if (!lines.length) continue;
          const mdLines: string[] = [`## ${sheetName}`];
          const headerCols = lines[0].split(',');
          mdLines.push(`| ${headerCols.join(' | ')} |`);
          mdLines.push(`| ${headerCols.map(() => '---').join(' | ')} |`);
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            mdLines.push(`| ${cols.join(' | ')} |`);
          }
          sections.push(mdLines.join('\n'));
        }

        if (!sections.length) return '';
        let content = header ? `${header}\n\n${sections.join('\n\n')}` : sections.join('\n\n');
        if (content.length > MAX_CONTENT_LENGTH) {
          content =
            content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
        }
        return content;
      }

      if (mime.startsWith('text/') && ext !== 'csv') {
        const text = buffer.toString('utf-8');
        if (!text.trim()) return '';
        let content = header ? `${header}\n\n${text.trim()}` : text.trim();
        if (content.length > MAX_CONTENT_LENGTH) {
          content =
            content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
        }
        return content;
      }

      this.logger.warn(`Unsupported file type for parsing: ${mimeType}`);
      return '';
    } catch (err) {
      this.logger.warn(
        `File parsing failed for ${mimeType}: ${err instanceof Error ? err.message : err}`,
      );
      return '';
    }
  }

  /**
   * Clean text based on source type and connector — strips noise, keeps signal.
   */
  cleanText(text: string, sourceType: string, connectorType: string): string {
    if (!text) return '';

    let cleaned = text;

    if (sourceType === 'email') {
      cleaned = this.cleanEmail(cleaned);
    } else if (sourceType === 'message') {
      cleaned = this.cleanMessage(cleaned, connectorType);
    }

    cleaned = this.sanitize(cleaned);
    return cleaned;
  }

  private cleanEmail(text: string): string {
    let plain = text;

    // Convert HTML to plain text
    if (/<[a-z][\s\S]*>/i.test(text)) {
      plain = convert(text, {
        wordwrap: false,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: 'script', format: 'skip' },
        ],
      });
    }

    // Strip signatures and quoted replies via email-reply-parser
    try {
      const { EmailReplyParser } = require('email-reply-parser');
      const email = new EmailReplyParser().read(plain);
      plain = email.getVisibleText();
    } catch {
      // Fallback: basic reply chain stripping
      plain = plain.replace(/^>.*$/gm, '').replace(/^On .+ wrote:$/gm, '');
      plain = plain.replace(/^-{5,}\s*Forwarded message\s*-{5,}[\s\S]*?^(?=\S)/gm, '');
    }

    // Strip common email signatures
    plain = plain.replace(/^--\s*\n[\s\S]*$/m, '');
    plain = plain.replace(/Sent from my (iPhone|iPad|Galaxy|Android|BlackBerry).*$/gm, '');

    return plain.trim();
  }

  private cleanMessage(text: string, connectorType: string): string {
    let cleaned = text;

    if (connectorType === 'slack') {
      // Slack markup: <@U123456> → @user, <#C123|channel> → #channel, <url|label> → label
      cleaned = cleaned.replace(/<@[A-Z0-9]+>/g, '@user');
      cleaned = cleaned.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
      cleaned = cleaned.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2');
      cleaned = cleaned.replace(/<(https?:\/\/[^>]+)>/g, '$1');
    }

    if (connectorType === 'whatsapp') {
      // WhatsApp formatting: *bold*, _italic_, ~strike~
      cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
      cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
      cleaned = cleaned.replace(/~([^~]+)~/g, '$1');
    }

    // Filter system messages
    if (
      /^(.*?\s)?(joined|left|added|removed|changed the topic|created this group)/i.test(cleaned)
    ) {
      return '';
    }

    // Filter "shared contact:" messages (low-value, pollute search)
    if (/^shared contact:/i.test(cleaned)) {
      return '';
    }

    return cleaned;
  }

  /**
   * Universal text sanitization — strips invisible/control characters, normalizes whitespace.
   */
  sanitize(text: string): string {
    let cleaned = text.replace(INVISIBLE_RE, '').replace(CONTROL_RE, '');
    cleaned = cleaned.replace(/[ \t]+/g, ' ');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  }
}
