import { describe, it, expect } from 'vitest';
import {
  formatSearchResults,
  formatMemory,
  formatMemoryList,
  formatContact,
  formatContactList,
  formatJob,
  formatJobList,
  formatStats,
  formatAccounts,
  formatVersion,
  formatAgentAnswer,
  formatAgentContext,
  formatMemoryBanks,
  formatStatus,
  toonify,
  bold,
  dim,
  green,
  red,
  yellow,
  cyan,
} from '../format.js';

describe('formatSearchResults', () => {
  it('should return "No results found." for empty array', () => {
    const result = formatSearchResults([]);
    expect(result).toContain('No results found');
  });

  it('should format results with rank, score, source, and text', () => {
    const results = [
      {
        id: 'mem-1',
        text: 'Hello world',
        sourceType: 'email',
        connectorType: 'gmail',
        eventTime: new Date().toISOString(),
        score: 0.85,
        weights: { final: 0.9123 },
      },
    ];
    const output = formatSearchResults(results);
    expect(output).toContain('#1');
    expect(output).toContain('0.9123');
    expect(output).toContain('email/gmail');
    expect(output).toContain('Hello world');
    expect(output).toContain('mem-1');
  });

  it('should use score when weights.final is missing', () => {
    const results = [
      {
        id: 'mem-1',
        text: 'Test',
        sourceType: 'message',
        connectorType: 'slack',
        eventTime: new Date().toISOString(),
        score: 0.75,
      },
    ];
    const output = formatSearchResults(results);
    expect(output).toContain('0.7500');
  });

  it('should truncate long text', () => {
    const results = [
      {
        id: 'mem-1',
        text: 'A'.repeat(200),
        sourceType: 'email',
        connectorType: 'gmail',
        eventTime: new Date().toISOString(),
      },
    ];
    const output = formatSearchResults(results);
    // Truncated to 120 chars, so should not contain 200 A's
    expect(output).not.toContain('A'.repeat(200));
  });
});

describe('formatMemory', () => {
  it('should display memory details', () => {
    const memory = {
      id: 'mem-1',
      text: 'Test memory content',
      sourceType: 'email',
      connectorType: 'gmail',
      eventTime: '2025-06-15T10:30:00Z',
      importance: 0.8,
      factuality: 'FACT',
      embeddingStatus: 'done',
      entities: null,
    };
    const output = formatMemory(memory);
    expect(output).toContain('Memory');
    expect(output).toContain('mem-1');
    expect(output).toContain('email/gmail');
    expect(output).toContain('2025-06-15T10:30:00Z');
    expect(output).toContain('0.8');
    expect(output).toContain('FACT');
    expect(output).toContain('done');
    expect(output).toContain('Test memory content');
  });

  it('should skip importance when null', () => {
    const memory = {
      id: 'm1',
      text: 'x',
      sourceType: 'email',
      connectorType: 'gmail',
      eventTime: '2025-01-01',
      importance: null,
      factuality: null,
      embeddingStatus: 'pending',
      entities: null,
    };
    const output = formatMemory(memory);
    expect(output).not.toContain('Import:');
  });

  it('should parse and display entities', () => {
    const memory = {
      id: 'm1',
      text: 'x',
      sourceType: 'email',
      connectorType: 'gmail',
      eventTime: '2025-01-01',
      importance: null,
      factuality: null,
      embeddingStatus: 'done',
      entities: JSON.stringify([{ value: 'Google' }, { value: 'AWS' }]),
    };
    const output = formatMemory(memory);
    expect(output).toContain('Entities:');
    expect(output).toContain('Google');
    expect(output).toContain('AWS');
  });

  it('should handle non-JSON entities gracefully', () => {
    const memory = {
      id: 'm1',
      text: 'x',
      sourceType: 'email',
      connectorType: 'gmail',
      eventTime: '2025-01-01',
      importance: null,
      factuality: null,
      embeddingStatus: 'done',
      entities: 'not-json',
    };
    // Should not throw
    const output = formatMemory(memory);
    expect(output).not.toContain('Entities:');
  });
});

describe('formatMemoryList', () => {
  it('should return "No memories found." for empty list', () => {
    expect(formatMemoryList([], 0)).toContain('No memories found');
  });

  it('should show items and total count', () => {
    const items = [
      {
        id: 'm1',
        text: 'Hello',
        sourceType: 'email',
        connectorType: 'gmail',
        eventTime: new Date().toISOString(),
      },
    ];
    const output = formatMemoryList(items, 100);
    expect(output).toContain('Hello');
    expect(output).toContain('email/gmail');
    expect(output).toContain('Showing 1 of 100');
  });
});

describe('formatContact', () => {
  it('should display contact name and identifiers', () => {
    const contact = {
      id: 'c1',
      displayName: 'Amr Essam',
      identifiers: [
        { identifierType: 'email', identifierValue: 'amr@test.com' },
        { identifierType: 'phone', identifierValue: '+1234567890' },
      ],
    };
    const output = formatContact(contact);
    expect(output).toContain('Amr Essam');
    expect(output).toContain('c1');
    expect(output).toContain('email');
    expect(output).toContain('amr@test.com');
    expect(output).toContain('+1234567890');
  });

  it('should show memory count when present', () => {
    const contact = {
      id: 'c1',
      displayName: 'Test',
      identifiers: [],
      memoryCount: 42,
    };
    const output = formatContact(contact);
    expect(output).toContain('42');
    expect(output).toContain('memories');
  });
});

describe('formatContactList', () => {
  it('should return "No contacts found." for empty list', () => {
    expect(formatContactList([], 0)).toContain('No contacts found');
  });

  it('should show contacts with identifiers', () => {
    const items = [
      {
        id: 'c1',
        displayName: 'Test User',
        identifiers: [{ identifierType: 'email', identifierValue: 'test@test.com' }],
      },
    ];
    const output = formatContactList(items, 50);
    expect(output).toContain('Test User');
    expect(output).toContain('test@test.com');
    expect(output).toContain('Showing 1 of 50');
  });
});

describe('formatJob', () => {
  it('should format a running job with progress bar', () => {
    const job = {
      id: 'j1',
      connector: 'gmail',
      accountIdentifier: 'test@gmail.com',
      status: 'running',
      progress: 50,
      total: 100,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    const output = formatJob(job);
    expect(output).toContain('running');
    expect(output).toContain('gmail');
    expect(output).toContain('test@gmail.com');
    expect(output).toContain('50%');
  });

  it('should show completion time for done jobs', () => {
    const job = {
      id: 'j1',
      connector: 'gmail',
      accountIdentifier: null,
      status: 'done',
      progress: null,
      total: null,
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: new Date().toISOString(),
      error: null,
    };
    const output = formatJob(job);
    expect(output).toContain('done');
    // Should contain a time ago reference
    expect(output).toContain('ago');
  });

  it('should show error for failed jobs', () => {
    const job = {
      id: 'j1',
      connector: 'slack',
      accountIdentifier: null,
      status: 'failed',
      progress: null,
      total: null,
      startedAt: null,
      completedAt: null,
      error: 'Connection timeout',
    };
    const output = formatJob(job);
    expect(output).toContain('Connection timeout');
  });
});

describe('formatJobList', () => {
  it('should return "No jobs found." for empty list', () => {
    expect(formatJobList([])).toContain('No jobs found');
  });
});

describe('formatStats', () => {
  it('should display total and breakdowns', () => {
    const stats = {
      total: 500,
      bySource: { email: 300, message: 200 },
      byConnector: { gmail: 300, slack: 200 },
      byFactuality: { FACT: 100, UNVERIFIED: 400 },
    };
    const output = formatStats(stats);
    expect(output).toContain('500');
    expect(output).toContain('By Source');
    expect(output).toContain('email');
    expect(output).toContain('300');
    expect(output).toContain('By Connector');
    expect(output).toContain('gmail');
    expect(output).toContain('By Factuality');
    expect(output).toContain('FACT');
  });
});

describe('formatAccounts', () => {
  it('should return "No connected accounts." for empty list', () => {
    expect(formatAccounts([])).toContain('No connected accounts');
  });

  it('should display accounts with sync info', () => {
    const accounts = [
      {
        id: 'a1',
        type: 'gmail',
        identifier: 'test@gmail.com',
        status: 'active',
        lastSync: new Date().toISOString(),
        memoriesIngested: 100,
      },
    ];
    const output = formatAccounts(accounts);
    expect(output).toContain('gmail');
    expect(output).toContain('test@gmail.com');
    expect(output).toContain('100 memories');
  });
});

describe('formatVersion', () => {
  it('should display build info and uptime', () => {
    const output = formatVersion({
      buildTime: '2025-01-01T00:00:00Z',
      gitHash: 'abc123',
      uptime: 90061, // 1d 1h 1m
    });
    expect(output).toContain('Botmem API');
    expect(output).toContain('2025-01-01T00:00:00Z');
    expect(output).toContain('abc123');
    expect(output).toContain('1d');
    expect(output).toContain('1h');
    expect(output).toContain('1m');
  });

  it('should handle short uptime', () => {
    const output = formatVersion({
      buildTime: '2025-01-01',
      gitHash: 'def',
      uptime: 120, // 2m
    });
    expect(output).toContain('2m');
    // Should not have days or hours component in uptime
    expect(output).not.toMatch(/\d+d/);
    expect(output).not.toMatch(/\d+h/);
  });
});

describe('formatAgentAnswer', () => {
  it('should format answer with sources', () => {
    const data = {
      answer: 'The project is on track.',
      results: [
        {
          sourceType: 'email',
          connectorType: 'gmail',
          text: 'Project update: on track',
          eventTime: new Date().toISOString(),
        },
      ],
    };
    const output = formatAgentAnswer(data);
    expect(output).toContain('Answer');
    expect(output).toContain('The project is on track.');
    expect(output).toContain('Sources (1)');
  });

  it('should show summary when present', () => {
    const data = { summary: 'A busy week.' };
    const output = formatAgentAnswer(data);
    expect(output).toContain('Summary');
    expect(output).toContain('A busy week.');
  });

  it('should show temporal fallback notice', () => {
    const data = {
      parsed: {
        temporalFallback: true,
        temporal: { from: '2025-01-01', to: '2025-01-31' },
      },
      answer: 'Some answer',
    };
    const output = formatAgentAnswer(data);
    expect(output).toContain('No memories found between');
    expect(output).toContain('general results instead');
  });

  it('should return "No results." when empty', () => {
    const output = formatAgentAnswer({});
    expect(output).toContain('No results');
  });
});

describe('formatAgentContext', () => {
  it('should display contact info and recent memories', () => {
    const data = {
      contact: {
        displayName: 'Amr',
        identifiers: [{ identifierType: 'email', identifierValue: 'amr@test.com' }],
      },
      stats: { totalMemories: 50 },
      recentMemories: [{ eventTime: new Date().toISOString(), text: 'Had a meeting' }],
    };
    const output = formatAgentContext(data);
    expect(output).toContain('Amr');
    expect(output).toContain('amr@test.com');
    expect(output).toContain('Stats');
    expect(output).toContain('totalMemories');
    expect(output).toContain('Recent memories');
    expect(output).toContain('Had a meeting');
  });

  it('should return "No context found." for empty data', () => {
    const output = formatAgentContext({});
    expect(output).toContain('No context found');
  });
});

describe('formatMemoryBanks', () => {
  it('should return "No memory banks." for empty list', () => {
    expect(formatMemoryBanks([])).toContain('No memory banks');
  });

  it('should list banks with memory counts', () => {
    const banks = [
      { id: 'b1', name: 'Work', memoryCount: 100 },
      { id: 'b2', name: 'Personal', memoryCount: 50 },
    ];
    const output = formatMemoryBanks(banks);
    expect(output).toContain('Work');
    expect(output).toContain('Personal');
    expect(output).toContain('100');
    expect(output).toContain('50');
    expect(output).toContain('2 bank(s)');
  });
});

describe('formatStatus', () => {
  it('should combine stats, queues, and accounts', () => {
    const stats = { total: 1000, bySource: { email: 800, message: 200 } };
    const queues = {
      sync: { waiting: 2, active: 1, failed: 0 },
      embed: { waiting: 5, active: 3, failed: 1 },
    };
    const accounts = [
      {
        id: 'a1',
        type: 'gmail',
        identifier: 'test@gmail.com',
        status: 'active',
        lastSync: new Date().toISOString(),
        memoriesIngested: 800,
      },
    ];
    const output = formatStatus(stats, queues, accounts);
    expect(output).toContain('BOTMEM STATUS');
    expect(output).toContain('1,000');
    expect(output).toContain('email: 800');
    expect(output).toContain('4 active');
    expect(output).toContain('7 waiting');
    expect(output).toContain('gmail');
    expect(output).toContain('test@gmail.com');
  });
});

describe('toonify', () => {
  it('should encode data to TOON format', () => {
    const output = toonify({ name: 'test', value: 42 });
    // TOON output should be a string representation
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('should parse JSON strings inside objects', () => {
    const data = { entities: JSON.stringify([{ value: 'Google' }]) };
    const output = toonify(data);
    // Should contain the parsed value, not the raw JSON string
    expect(output).toContain('Google');
  });
});

describe('ANSI helpers', () => {
  // These depend on process.stdout.isTTY and NO_COLOR env
  it('bold should return a string', () => {
    expect(typeof bold('test')).toBe('string');
    expect(bold('test')).toContain('test');
  });

  it('dim should return a string', () => {
    expect(dim('test')).toContain('test');
  });

  it('color functions should return strings containing the input', () => {
    expect(green('ok')).toContain('ok');
    expect(red('err')).toContain('err');
    expect(yellow('warn')).toContain('warn');
    expect(cyan('info')).toContain('info');
  });
});
