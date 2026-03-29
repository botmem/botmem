import { describe, it, expect, vi } from 'vitest';

// Mock html-to-text — strip tags naively for test purposes
vi.mock('html-to-text', () => ({
  convert: (html: string) => html.replace(/<[^>]+>/g, ''),
}));

// Mock email-reply-parser
vi.mock('email-reply-parser', () => ({
  EmailReplyParser: class {
    read(text: string) {
      // Simple mock: strip lines starting with ">"
      const visible = text
        .split('\n')
        .filter((l: string) => !l.startsWith('>') && !/^On .+ wrote:$/.test(l))
        .join('\n');
      return { getVisibleText: () => visible };
    }
  },
}));

import { ContentCleaner } from '../content-cleaner';

describe('ContentCleaner', () => {
  const cleaner = new ContentCleaner();

  describe('cleanText()', () => {
    it('returns empty string for empty input', () => {
      expect(cleaner.cleanText('', 'email', 'gmail')).toBe('');
    });

    it('returns normal text unchanged', () => {
      expect(cleaner.cleanText('Hello world', 'message', 'slack')).toBe('Hello world');
    });

    // ─── Email cleaning ───

    it('strips HTML tags from email', () => {
      const html = '<div><p>Hello <b>World</b></p><img src="x.png"></div>';
      const result = cleaner.cleanText(html, 'email', 'gmail');
      expect(result).toContain('Hello');
      expect(result).toContain('World');
      expect(result).not.toContain('<div>');
      expect(result).not.toContain('<b>');
      expect(result).not.toContain('<img');
    });

    it('strips email signature (-- separator)', () => {
      const text = 'Main content here.\n-- \nJohn Doe\nSenior Engineer';
      const result = cleaner.cleanText(text, 'email', 'gmail');
      expect(result).toContain('Main content');
      expect(result).not.toContain('John Doe');
      expect(result).not.toContain('Senior Engineer');
    });

    it('strips quoted reply chains', () => {
      const text = 'Thanks for the update.\n> On Mar 15, John wrote:\n> Some previous message';
      const result = cleaner.cleanText(text, 'email', 'gmail');
      expect(result).toContain('Thanks for the update');
      // The reply parser should strip the quoted part
      expect(result).not.toContain('> Some previous message');
    });

    it('strips forwarded message headers', () => {
      const text =
        'FYI see below.\n---------- Forwarded message ---------\nFrom: John\nTo: Jane\nOriginal content here';
      const result = cleaner.cleanText(text, 'email', 'gmail');
      expect(result).toContain('FYI');
    });

    it('strips "Sent from my iPhone"', () => {
      const text = 'Quick reply.\nSent from my iPhone';
      const result = cleaner.cleanText(text, 'email', 'gmail');
      expect(result).toContain('Quick reply');
      expect(result).not.toContain('Sent from my iPhone');
    });

    // ─── Slack message cleaning ───

    it('replaces Slack user mentions <@U123456> with @user', () => {
      const result = cleaner.cleanText('Hey <@U123456> check this', 'message', 'slack');
      expect(result).toBe('Hey @user check this');
    });

    it('replaces Slack channel references <#C123|general> with #general', () => {
      const result = cleaner.cleanText('See <#C123|general> for details', 'message', 'slack');
      expect(result).toBe('See #general for details');
    });

    it('replaces Slack link markup with label', () => {
      const result = cleaner.cleanText(
        'Read <https://example.com|this article>',
        'message',
        'slack',
      );
      expect(result).toBe('Read this article');
    });

    it('unwraps bare Slack URLs', () => {
      const result = cleaner.cleanText('Visit <https://example.com>', 'message', 'slack');
      expect(result).toBe('Visit https://example.com');
    });

    // ─── WhatsApp message cleaning ───

    it('strips WhatsApp *bold* formatting', () => {
      const result = cleaner.cleanText('This is *bold* text', 'message', 'whatsapp');
      expect(result).toBe('This is bold text');
    });

    it('strips WhatsApp _italic_ formatting', () => {
      const result = cleaner.cleanText('This is _italic_ text', 'message', 'whatsapp');
      expect(result).toBe('This is italic text');
    });

    it('strips WhatsApp ~strikethrough~ formatting', () => {
      const result = cleaner.cleanText('This is ~struck~ text', 'message', 'whatsapp');
      expect(result).toBe('This is struck text');
    });

    // ─── System / junk messages ───

    it('returns empty for system "joined" messages', () => {
      expect(cleaner.cleanText('John joined', 'message', 'whatsapp')).toBe('');
    });

    it('returns empty for system "left" messages', () => {
      expect(cleaner.cleanText('Alice left', 'message', 'slack')).toBe('');
    });

    it('returns empty for "added" messages', () => {
      expect(cleaner.cleanText('Bob added Carol', 'message', 'whatsapp')).toBe('');
    });

    it('returns empty for "shared contact:" messages', () => {
      expect(cleaner.cleanText('shared contact: John Doe', 'message', 'whatsapp')).toBe('');
    });

    // ─── Sanitization ───

    it('strips control characters', () => {
      const result = cleaner.cleanText('Hello\x00World\x07!', 'message', 'slack');
      expect(result).toBe('HelloWorld!');
    });

    it('normalizes excessive whitespace', () => {
      const result = cleaner.cleanText('Hello   World', 'message', 'slack');
      expect(result).toBe('Hello World');
    });

    it('collapses multiple blank lines', () => {
      const result = cleaner.cleanText('Line1\n\n\n\nLine2', 'message', 'slack');
      expect(result).toBe('Line1\n\nLine2');
    });
  });

  describe('parseFile()', () => {
    it('returns empty string for unsupported mime type', async () => {
      const buf = Buffer.from('binary data');
      const result = await cleaner.parseFile(buf, 'application/octet-stream', 'file.bin');
      expect(result).toBe('');
    });

    it('parses plain text files', async () => {
      const buf = Buffer.from('Hello, world!');
      const result = await cleaner.parseFile(buf, 'text/plain', 'readme.txt');
      expect(result).toContain('readme.txt');
      expect(result).toContain('Hello, world!');
    });

    it('returns empty for empty text file', async () => {
      const buf = Buffer.from('   ');
      const result = await cleaner.parseFile(buf, 'text/plain', 'empty.txt');
      expect(result).toBe('');
    });

    it('truncates content exceeding MAX_CONTENT_LENGTH', async () => {
      const longText = 'x'.repeat(15_000);
      const buf = Buffer.from(longText);
      const result = await cleaner.parseFile(buf, 'text/plain');
      expect(result.length).toBeLessThanOrEqual(10_000);
      expect(result).toContain('[Truncated]');
    });

    it.todo('parses PDF files (requires pdf-parse fixture)');
    it.todo('parses DOCX files (requires mammoth fixture)');
    it.todo('parses XLSX files (requires xlsx fixture)');
  });

  describe('sanitize()', () => {
    it('strips invisible unicode characters', () => {
      // U+200B zero-width space
      const result = cleaner.sanitize('Hello\u200BWorld');
      expect(result).toBe('HelloWorld');
    });

    it('trims leading/trailing whitespace', () => {
      expect(cleaner.sanitize('  hello  ')).toBe('hello');
    });
  });
});
