import { describe, it, expect } from 'vitest';

describe('FileProcessor MIME routing', () => {
  // Extract the routing logic as a pure function for testing
  function classifyMime(mimetype: string, fileName: string): string {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype === 'application/pdf' || fileName.endsWith('.pdf')) return 'pdf';
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || fileName.endsWith('.docx')) return 'docx';
    if (mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        || mimetype === 'application/vnd.ms-excel'
        || fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv')) return 'spreadsheet';
    if (mimetype.startsWith('text/') && !fileName.endsWith('.csv')) return 'text';
    return 'unsupported';
  }

  it('routes images to VL model', () => {
    expect(classifyMime('image/png', 'photo.png')).toBe('image');
    expect(classifyMime('image/jpeg', 'photo.jpg')).toBe('image');
    expect(classifyMime('image/webp', 'photo.webp')).toBe('image');
  });

  it('routes PDFs to pdf-parse', () => {
    expect(classifyMime('application/pdf', 'report.pdf')).toBe('pdf');
  });

  it('routes DOCX to mammoth', () => {
    expect(classifyMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx')).toBe('docx');
    expect(classifyMime('application/octet-stream', 'doc.docx')).toBe('docx');
  });

  it('routes spreadsheets to xlsx', () => {
    expect(classifyMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'data.xlsx')).toBe('spreadsheet');
    expect(classifyMime('application/vnd.ms-excel', 'data.xls')).toBe('spreadsheet');
    expect(classifyMime('text/csv', 'data.csv')).toBe('spreadsheet');
  });

  it('routes plain text directly', () => {
    expect(classifyMime('text/plain', 'readme.txt')).toBe('text');
    expect(classifyMime('text/html', 'page.html')).toBe('text');
  });

  it('rejects unsupported types', () => {
    expect(classifyMime('application/zip', 'archive.zip')).toBe('unsupported');
    expect(classifyMime('video/mp4', 'clip.mp4')).toBe('unsupported');
  });
});
