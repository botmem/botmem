import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { PublicFooter } from '../components/layout/PublicFooter';
import { usePageMeta } from '../hooks/usePageMeta';

const GITHUB_URL = 'https://github.com/botmem/botmem';

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-nb-lime shrink-0 mt-0.5"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-nb-lime focus:text-black focus:font-display focus:font-bold focus:border-3 focus:border-nb-border focus:shadow-nb"
    >
      Skip to content
    </a>
  );
}

function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks = [
    { href: '#features', label: 'FEATURES' },
    { href: '#how-it-works', label: 'HOW IT WORKS' },
    { href: '#open-source', label: 'OPEN SOURCE' },
    { href: '#security', label: 'SECURITY' },
    { href: '#pricing', label: 'PRICING' },
    { href: 'https://docs.botmem.xyz', label: 'DOCS', external: true },
  ];

  return (
    <nav
      className="sticky top-0 z-40 bg-nb-bg/95 backdrop-blur-sm border-b-4 border-nb-border"
      aria-label="Main navigation"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
        <Link to="/" aria-label="Botmem home" className="cursor-pointer">
          <Logo variant="full" height={28} />
        </Link>
        <div className="hidden sm:flex items-center gap-6 font-display text-sm tracking-wide">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              {...('external' in link && link.external
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {})}
              className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
            >
              {link.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="sm:hidden border-2 border-nb-border w-11 h-11 flex items-center justify-center hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              {mobileMenuOpen ? (
                <path d="M4 4l10 10M14 4l-10 10" />
              ) : (
                <>
                  <line x1="2" y1="4" x2="16" y2="4" />
                  <line x1="2" y1="9" x2="16" y2="9" />
                  <line x1="2" y1="14" x2="16" y2="14" />
                </>
              )}
            </svg>
          </button>
          <ThemeToggle />
          <Link
            to="/signup"
            className="hidden sm:inline-block font-display text-sm font-bold px-5 py-2 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer"
          >
            GET STARTED
          </Link>
        </div>
      </div>

      {/* Mobile menu dropdown */}
      {mobileMenuOpen && (
        <div className="sm:hidden border-t-3 border-nb-border bg-nb-surface">
          <div className="flex flex-col font-display text-sm tracking-wide">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                {...('external' in link && link.external
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
                onClick={() => setMobileMenuOpen(false)}
                className="px-4 py-3 text-nb-muted hover:text-nb-text hover:bg-nb-surface-hover transition-colors border-b border-nb-border/30 cursor-pointer"
              >
                {link.label}
              </a>
            ))}
            <Link
              to="/signup"
              onClick={() => setMobileMenuOpen(false)}
              className="px-4 py-3 font-bold bg-nb-lime text-black cursor-pointer"
            >
              GET STARTED
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}

function Hero() {
  return (
    <section className="px-4 sm:px-6 pt-20 pb-24 max-w-6xl mx-auto" aria-labelledby="hero-heading">
      <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <div>
          <h1
            id="hero-heading"
            className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold uppercase leading-[1.1] tracking-tight"
          >
            YOUR LIFE,
            <br />
            <span className="text-nb-lime">SEARCHABLE.</span>
          </h1>
          <p className="mt-6 font-mono text-lg text-nb-muted leading-relaxed max-w-lg">
            Local-first personal memory from your email, messages, photos, and locations. All on
            your hardware.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              to="/signup"
              className="font-display text-sm font-bold px-8 py-3 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
            >
              START FREE
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-display text-sm font-bold px-8 py-3 bg-transparent text-nb-text border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none hover:bg-nb-surface active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
            >
              VIEW ON GITHUB
            </a>
          </div>
        </div>
        <TerminalBlock />
      </div>
    </section>
  );
}

function TerminalBlock() {
  return (
    <div
      className="bg-nb-surface border-3 border-nb-border shadow-nb-lg font-mono text-sm overflow-hidden"
      role="img"
      aria-label="Terminal showing a Botmem search query with scored results"
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b-3 border-nb-border bg-nb-bg">
        <span className="size-3 bg-nb-red border border-nb-border" />
        <span className="size-3 bg-nb-yellow border border-nb-border" />
        <span className="size-3 bg-nb-green border border-nb-border" />
        <span className="ml-2 text-nb-muted text-xs">botmem</span>
      </div>
      <div className="p-4 sm:p-5 flex flex-col gap-3 text-[13px] leading-relaxed">
        <div>
          <span className="text-nb-lime">$</span>{' '}
          <span className="text-nb-text">
            botmem search &quot;dinner with sarah last month&quot;
          </span>
        </div>
        <div className="text-nb-muted">Searching 12,847 memories...</div>
        <div className="border-t border-nb-border/30 pt-3 flex flex-col gap-3">
          <ResultLine
            score="0.94"
            source="gmail"
            text="Re: Dinner reservation at Nobu — confirmed for Feb 14"
            time="2026-02-12"
          />
          <ResultLine
            score="0.87"
            source="whatsapp"
            text="Sarah: 'Can't wait for dinner tomorrow!'"
            time="2026-02-13"
          />
          <ResultLine
            score="0.71"
            source="photos"
            text="IMG_4021.jpg — 2 people, restaurant, evening"
            time="2026-02-14"
          />
        </div>
        <div className="text-nb-muted pt-1">
          3 results · 48ms · scored by semantic + recency + trust
        </div>
      </div>
    </div>
  );
}

function ResultLine({
  score,
  source,
  text,
  time,
}: {
  score: string;
  source: string;
  text: string;
  time: string;
}) {
  const sourceColor: Record<string, string> = {
    gmail: 'text-nb-blue',
    whatsapp: 'text-nb-green',
    photos: 'text-nb-purple',
  };
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
      <span className="text-nb-lime font-bold shrink-0">[{score}]</span>
      <span className={cn('uppercase font-bold shrink-0', sourceColor[source] ?? 'text-nb-muted')}>
        {source}
      </span>
      <span className="text-nb-text flex-1 break-words">{text}</span>
      <span className="text-nb-muted shrink-0">{time}</span>
    </div>
  );
}

function ProblemSection() {
  const problems = [
    { name: 'GMAIL', desc: 'Separate search, separate context' },
    { name: 'SLACK', desc: 'Separate search, separate context' },
    { name: 'WHATSAPP', desc: 'Separate search, separate context' },
  ];
  return (
    <section
      className="px-4 sm:px-6 py-20 border-t-4 border-nb-border"
      aria-labelledby="problem-heading"
    >
      <div className="max-w-6xl mx-auto">
        <h2
          id="problem-heading"
          className="font-display text-3xl sm:text-4xl font-bold uppercase text-center"
        >
          YOUR DATA IS <span className="text-nb-pink">SCATTERED</span>
        </h2>
        <div className="mt-12 grid sm:grid-cols-3 gap-6">
          {problems.map((p) => (
            <div key={p.name} className="bg-nb-surface border-3 border-nb-border p-6 shadow-nb-sm">
              <h3 className="font-display text-lg font-bold text-nb-muted">{p.name}</h3>
              <p className="font-mono text-sm text-nb-muted mt-2">{p.desc}</p>
            </div>
          ))}
        </div>
        <div className="flex justify-center my-8">
          <svg
            width="24"
            height="48"
            viewBox="0 0 24 48"
            fill="none"
            aria-hidden="true"
            className="text-nb-lime"
          >
            <path d="M12 0v40m0 0l-8-8m8 8l8-8" stroke="currentColor" strokeWidth="3" />
          </svg>
        </div>
        <div className="bg-nb-surface border-3 border-nb-lime p-6 shadow-nb text-center">
          <div className="flex justify-center mb-2">
            <Logo variant="mark" height={40} />
          </div>
          <p className="font-mono text-sm text-nb-text mt-2">
            One search. All your memories. Ranked by relevance, recency, and trust.
          </p>
        </div>
      </div>
    </section>
  );
}

const FEATURES: { icon: ReactNode; title: string; desc: string }[] = [
  {
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="12" r="3" />
        <circle cx="16" cy="12" r="3" />
        <path d="M11 12h2" />
      </svg>
    ),
    title: '6 CONNECTORS',
    desc: 'Gmail, Slack, WhatsApp, iMessage, Photos, Locations — more coming.',
  },
  {
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <ellipse cx="12" cy="7" rx="8" ry="3" />
        <path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
        <path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5" />
      </svg>
    ),
    title: 'FULLY LOCAL',
    desc: 'SQLite + Qdrant + Ollama. Your data never leaves your hardware.',
  },
  {
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21a6 6 0 0 1 12 0" />
        <circle cx="17" cy="8" r="2.5" />
        <path d="M20 21a3.5 3.5 0 0 0-5-3.2" />
      </svg>
    ),
    title: 'CONTACT GRAPH',
    desc: 'Unified people directory merged across every source automatically.',
  },
  {
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    ),
    title: 'FACTUALITY',
    desc: 'Every memory classified: FACT, UNVERIFIED, or FICTION with confidence.',
  },
  {
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="17" r="2" />
        <circle cx="19" cy="17" r="2" />
        <path d="M12 7v4M12 11l-5.5 4.5M12 11l5.5 4.5" />
      </svg>
    ),
    title: 'MEMORY GRAPH',
    desc: 'Force-directed visualization of relationships between your memories.',
  },
  {
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
        <line x1="14" y1="4" x2="10" y2="20" />
      </svg>
    ),
    title: 'AGENT API',
    desc: 'CLI + REST + WebSocket. Let your AI agents query your life.',
  },
];

function FeaturesSection() {
  return (
    <section
      id="features"
      className="px-4 sm:px-6 py-20 border-t-4 border-nb-border"
      aria-labelledby="features-heading"
    >
      <div className="max-w-6xl mx-auto">
        <h2
          id="features-heading"
          className="font-display text-3xl sm:text-4xl font-bold uppercase text-center"
        >
          FEATURES
        </h2>
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-nb-surface border-3 border-nb-border p-6 shadow-nb">
              <div className="font-display text-2xl text-nb-lime mb-3" aria-hidden="true">
                {f.icon}
              </div>
              <h3 className="font-display text-base font-bold tracking-wide">{f.title}</h3>
              <p className="font-mono text-sm text-nb-muted mt-2 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const HOW_IT_WORKS_TABS = [
  {
    id: 'mcp',
    label: 'MCP SERVER',
    audience: 'For AI Agents',
    titleBar: 'claude / cursor / windsurf',
    lines: [
      {
        type: 'comment' as const,
        text: '# Your AI agent connects to Botmem automatically',
      },
      {
        type: 'prompt' as const,
        text: '"What did Sarah say about the project deadline?"',
      },
      {
        type: 'result' as const,
        text: 'Searching 12,847 memories via MCP...',
      },
      {
        type: 'result' as const,
        text: '[0.94] slack — Sarah: "Deadline moved to March 20th"',
      },
      {
        type: 'result' as const,
        text: '[0.87] gmail — Re: Project Timeline — confirmed March 20',
      },
      {
        type: 'comment' as const,
        text: '# Works with Claude, Cursor, Windsurf, any MCP client',
      },
    ],
  },
  {
    id: 'cli',
    label: 'CLI',
    audience: 'For Developers',
    titleBar: 'terminal',
    lines: [
      {
        type: 'cmd' as const,
        text: 'npx botmem search "dinner with sarah last month"',
      },
      { type: 'result' as const, text: 'Searching 12,847 memories...' },
      { type: 'divider' as const, text: '' },
      {
        type: 'hit' as const,
        score: '0.94',
        source: 'gmail',
        text: 'Re: Dinner reservation at Nobu — confirmed for Feb 14',
        time: '2026-02-12',
      },
      {
        type: 'hit' as const,
        score: '0.87',
        source: 'whatsapp',
        text: "Sarah: 'Can't wait for dinner tomorrow!'",
        time: '2026-02-13',
      },
      {
        type: 'hit' as const,
        score: '0.71',
        source: 'photos',
        text: 'IMG_4021.jpg — 2 people, restaurant, evening',
        time: '2026-02-14',
      },
      {
        type: 'meta' as const,
        text: '3 results · 48ms · scored by semantic + recency + trust',
      },
    ],
  },
  {
    id: 'api',
    label: 'REST API',
    audience: 'For Integrations',
    titleBar: 'http',
    lines: [
      {
        type: 'cmd' as const,
        text: 'curl -X POST https://botmem.xyz/api/memory/search \\',
      },
      {
        type: 'continued' as const,
        text: '  -H "Authorization: Bearer $TOKEN" \\',
      },
      {
        type: 'continued' as const,
        text: '  -d \'{"query": "dinner with sarah", "limit": 5}\'',
      },
      { type: 'divider' as const, text: '' },
      { type: 'result' as const, text: '{' },
      { type: 'result' as const, text: '  "results": [' },
      {
        type: 'result' as const,
        text: '    { "score": 0.94, "source": "gmail",',
      },
      {
        type: 'result' as const,
        text: '      "text": "Dinner reservation at Nobu..." },',
      },
      { type: 'result' as const, text: '    ...' },
      { type: 'result' as const, text: '  ],' },
      { type: 'result' as const, text: '  "count": 3, "took_ms": 48' },
      { type: 'result' as const, text: '}' },
    ],
  },
];

function HowItWorks() {
  const [activeTab, setActiveTab] = useState(0);
  const tab = HOW_IT_WORKS_TABS[activeTab];

  const sourceColor: Record<string, string> = {
    gmail: 'text-nb-blue',
    whatsapp: 'text-nb-green',
    photos: 'text-nb-purple',
    slack: 'text-nb-orange',
  };

  return (
    <section
      id="how-it-works"
      className="px-4 sm:px-6 py-20 border-t-4 border-nb-border"
      aria-labelledby="how-heading"
    >
      <div className="max-w-6xl mx-auto">
        <h2
          id="how-heading"
          className="font-display text-3xl sm:text-4xl font-bold uppercase text-center"
        >
          HOW IT <span className="text-nb-lime">WORKS</span>
        </h2>
        <p className="font-mono text-sm text-nb-muted mt-4 text-center max-w-xl mx-auto leading-relaxed">
          Three ways to query your memories. Pick what fits your workflow.
        </p>

        {/* Tab buttons */}
        <div
          className="mt-12 flex flex-col sm:flex-row gap-3 sm:gap-0 max-w-2xl mx-auto"
          role="tablist"
          aria-label="Integration methods"
        >
          {HOW_IT_WORKS_TABS.map((t, i) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === i}
              aria-controls={`panel-${t.id}`}
              id={`tab-${t.id}`}
              onClick={() => setActiveTab(i)}
              className={cn(
                'flex-1 font-display text-sm font-bold tracking-wide px-4 py-3 border-3 border-nb-border transition-all duration-150 cursor-pointer',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-nb-lime focus-visible:ring-offset-2 focus-visible:ring-offset-nb-bg',
                activeTab === i
                  ? 'bg-nb-lime text-black shadow-nb -translate-x-[1px] -translate-y-[1px]'
                  : 'bg-nb-surface text-nb-muted hover:bg-nb-bg hover:text-nb-text',
                i > 0 && 'sm:-ml-[3px]',
              )}
            >
              <div>{t.label}</div>
              <div
                className={cn(
                  'text-[10px] font-mono font-normal tracking-normal mt-0.5',
                  activeTab === i ? 'text-black/60' : 'text-nb-muted',
                )}
              >
                {t.audience}
              </div>
            </button>
          ))}
        </div>

        {/* Terminal panel */}
        <div
          id={`panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
          className="mt-0 sm:-mt-[3px] bg-nb-surface border-3 border-nb-border shadow-nb-lg font-mono text-sm overflow-hidden max-w-2xl mx-auto"
        >
          <div className="flex items-center gap-2 px-4 py-2 border-b-3 border-nb-border bg-nb-bg">
            <span className="size-3 bg-nb-red border border-nb-border" />
            <span className="size-3 bg-nb-yellow border border-nb-border" />
            <span className="size-3 bg-nb-green border border-nb-border" />
            <span className="ml-2 text-nb-muted text-xs">{tab.titleBar}</span>
          </div>
          <div className="p-4 sm:p-5 flex flex-col gap-1 text-[13px] leading-relaxed min-h-[260px]">
            {tab.lines.map((line, i) => {
              const lineKey = `${line.type}-${i}`;
              if (line.type === 'cmd')
                return (
                  <div key={lineKey}>
                    <span className="text-nb-lime">$</span>{' '}
                    <span className="text-nb-text">{line.text}</span>
                  </div>
                );
              if (line.type === 'continued')
                return (
                  <div key={lineKey} className="text-nb-text">
                    {line.text}
                  </div>
                );
              if (line.type === 'comment')
                return (
                  <div key={lineKey} className="text-nb-muted">
                    {line.text}
                  </div>
                );
              if (line.type === 'prompt')
                return (
                  <div key={lineKey}>
                    <span className="text-nb-lime">{'>'}</span>{' '}
                    <span className="text-nb-text italic">{line.text}</span>
                  </div>
                );
              if (line.type === 'divider')
                return (
                  <div
                    key={lineKey}
                    className="border-t border-nb-border/30 my-2"
                    aria-hidden="true"
                  />
                );
              if (line.type === 'meta')
                return (
                  <div key={lineKey} className="text-nb-muted pt-2">
                    {line.text}
                  </div>
                );
              if (line.type === 'hit' && 'score' in line)
                return (
                  <div
                    key={lineKey}
                    className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3"
                  >
                    <span className="text-nb-lime font-bold shrink-0">[{line.score}]</span>
                    <span
                      className={cn(
                        'uppercase font-bold shrink-0',
                        sourceColor[line.source ?? ''] ?? 'text-nb-muted',
                      )}
                    >
                      {line.source}
                    </span>
                    <span className="text-nb-text flex-1 break-words">{line.text}</span>
                    <span className="text-nb-muted shrink-0">{line.time}</span>
                  </div>
                );
              // result
              return (
                <div key={lineKey} className="text-nb-muted">
                  {line.text}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step indicators below */}
        <div className="mt-6 flex justify-center gap-2">
          {HOW_IT_WORKS_TABS.map((t, i) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(i)}
              className={cn(
                'size-2 border border-nb-border transition-all duration-200 cursor-pointer',
                activeTab === i ? 'bg-nb-lime scale-125' : 'bg-nb-surface hover:bg-nb-muted',
              )}
              aria-label={`Show ${t.label}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function TechStrip() {
  const techs = ['NestJS', 'PostgreSQL', 'Qdrant', 'Ollama', 'React', 'BullMQ'];
  return (
    <div className="border-y-4 border-nb-border py-5 overflow-hidden">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-wrap justify-center gap-x-6 gap-y-2 font-mono text-sm text-nb-muted tracking-wide">
        {techs.map((t, i) => (
          <span key={t}>
            {t}
            {i < techs.length - 1 && (
              <span className="ml-6 text-nb-border/40" aria-hidden="true">
                ·
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

const FREE_FEATURES = [
  'All 6 connectors',
  'Unlimited memories',
  'Local AI enrichment',
  'Contact graph',
  'Memory graph visualization',
  'CLI + REST API',
  'Community support',
];

const PRO_FEATURES = [
  'Everything in Free',
  'Cloud-hosted infrastructure',
  'Managed Qdrant + Redis',
  'Priority enrichment pipeline',
  'Advanced analytics dashboard',
  'Full API access + webhooks',
  'Email support',
  'Automatic backups',
];

function PricingSection() {
  return (
    <section
      id="pricing"
      className="px-4 sm:px-6 py-20 border-t-4 border-nb-border"
      aria-labelledby="pricing-heading"
    >
      <div className="max-w-6xl mx-auto">
        <h2
          id="pricing-heading"
          className="font-display text-3xl sm:text-4xl font-bold uppercase text-center"
        >
          SIMPLE, <span className="text-nb-lime">HONEST</span> PRICING
        </h2>
        <p className="font-mono text-sm text-nb-muted mt-4 text-center max-w-xl mx-auto">
          Self-host for free or let us handle the infrastructure. Same open-source code either way.
        </p>
        <div className="mt-12 grid sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {/* Free tier */}
          <div className="bg-nb-surface border-3 border-nb-border p-6 shadow-nb flex flex-col">
            <div className="mb-6">
              <h3 className="font-display text-lg font-bold tracking-wide uppercase">FREE</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="font-display text-4xl font-bold">$0</span>
                <span className="font-mono text-sm text-nb-muted">/forever</span>
              </div>
              <p className="font-mono text-sm text-nb-muted mt-2">
                Self-hosted on your hardware. Full control.
              </p>
            </div>
            <ul className="flex flex-col gap-3 flex-1" aria-label="Free tier features">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 font-mono text-sm text-nb-text">
                  <CheckIcon />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 font-display text-sm font-bold px-8 py-3 bg-transparent text-nb-text border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none hover:bg-nb-surface active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block text-center"
            >
              SELF-HOST FREE
            </a>
          </div>
          {/* Pro tier */}
          <div className="bg-nb-surface border-3 border-nb-lime p-6 shadow-nb flex flex-col relative">
            <div className="absolute -top-4 right-4 bg-nb-lime text-black font-display text-xs font-bold px-3 py-1 border-3 border-nb-border">
              RECOMMENDED
            </div>
            <div className="mb-6">
              <h3 className="font-display text-lg font-bold tracking-wide uppercase text-nb-lime">
                PRO
              </h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="font-display text-4xl font-bold">$14.99</span>
                <span className="font-mono text-sm text-nb-muted">/month</span>
              </div>
              <p className="font-mono text-sm text-nb-muted mt-2">
                We handle the infrastructure. You keep the memories.
              </p>
            </div>
            <ul className="flex flex-col gap-3 flex-1" aria-label="Pro tier features">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 font-mono text-sm text-nb-text">
                  <CheckIcon />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link
              to="/signup"
              className="mt-8 font-display text-sm font-bold px-8 py-3 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block text-center"
            >
              START PRO
            </Link>
            <p className="font-mono text-xs text-nb-muted mt-3 text-center">
              14-day free trial · Cancel anytime
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function SecuritySection() {
  const items = [
    {
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
      title: 'AES-256-GCM',
      desc: 'All credentials and sensitive data encrypted at rest with AES-256-GCM. Authenticated encryption that prevents tampering.',
    },
    {
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      ),
      title: 'RECOVERY KEY',
      desc: "Your encryption key is generated once and shown only to you. We store a hash — never the key itself. Password changes don't affect encryption.",
    },
    {
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      title: 'ZERO KNOWLEDGE',
      desc: 'Self-hosted: data never leaves your hardware. Pro: we cannot read your encrypted credentials. Your recovery key stays with you.',
    },
    {
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      ),
      title: 'AUDITABLE',
      desc: "Every line of encryption code is open-source and auditable on GitHub. Don't trust us — read the code.",
    },
  ];

  return (
    <section
      id="security"
      className="px-4 sm:px-6 py-20 border-t-4 border-nb-border"
      aria-labelledby="security-heading"
    >
      <div className="max-w-6xl mx-auto">
        <h2
          id="security-heading"
          className="font-display text-3xl sm:text-4xl font-bold uppercase text-center"
        >
          SECURITY <span className="text-nb-lime">BY DEFAULT</span>
        </h2>
        <p className="font-mono text-sm text-nb-muted mt-4 text-center max-w-xl mx-auto leading-relaxed">
          Your memories are personal. Our encryption ensures they stay that way — whether you
          self-host or use Pro.
        </p>
        <div className="mt-12 grid sm:grid-cols-2 gap-6">
          {items.map((item) => (
            <div key={item.title} className="bg-nb-surface border-3 border-nb-border p-6 shadow-nb">
              <div className="text-nb-lime mb-3" aria-hidden="true">
                {item.icon}
              </div>
              <h3 className="font-display text-base font-bold tracking-wide">{item.title}</h3>
              <p className="font-mono text-sm text-nb-muted mt-2 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link
            to="/data-policy"
            className="font-mono text-sm text-nb-lime hover:underline cursor-pointer transition-colors duration-200"
          >
            Read our full data policy →
          </Link>
        </div>
      </div>
    </section>
  );
}

function OpenSourceCTA() {
  return (
    <section id="open-source" className="px-4 sm:px-6 py-24" aria-labelledby="oss-heading">
      <div className="max-w-3xl mx-auto text-center">
        <h2 id="oss-heading" className="font-display text-3xl sm:text-4xl font-bold uppercase">
          100% <span className="text-nb-lime">OPEN SOURCE</span>
        </h2>
        <p className="font-mono text-sm text-nb-muted mt-4 tracking-widest uppercase">
          MIT License · Auditable · Extensible
        </p>
        <p className="font-mono text-sm text-nb-muted mt-3 max-w-lg mx-auto leading-relaxed">
          Self-host on your own hardware for free, or let us run it for you with Botmem Pro. Same
          code, same features, your choice.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-display text-sm font-bold px-8 py-3 bg-transparent text-nb-text border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none hover:bg-nb-surface active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
          >
            STAR ON GITHUB
          </a>
          <Link
            to="/signup"
            className="font-display text-sm font-bold px-8 py-3 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
          >
            GET STARTED
          </Link>
        </div>
      </div>
    </section>
  );
}

export function LandingPage() {
  const mainRef = useRef<HTMLDivElement>(null);

  usePageMeta({
    title: 'Botmem — Your Life, Searchable. Personal Memory for AI Agents.',
    description:
      'Open-source personal memory system. Ingest Gmail, Slack, WhatsApp, iMessage, photos, and locations into one AI-powered searchable memory. Self-hosted, local-first, privacy-focused. MCP server for Claude, Cursor, and AI agents.',
    canonical: 'https://botmem.xyz/',
    ogTitle: 'Botmem — Your Life, Searchable',
    ogDescription: 'Self-hosted personal memory. Search your entire digital life locally with AI.',
  });

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('landing-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 },
    );

    const sections = mainRef.current?.querySelectorAll('.landing-fade-in');
    sections?.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={mainRef} className="min-h-screen bg-nb-bg text-nb-text">
      <SkipToContent />
      <Navbar />
      <main id="main-content">
        <div className="landing-fade-in">
          <Hero />
        </div>
        <div className="landing-fade-in">
          <ProblemSection />
        </div>
        <div className="landing-fade-in">
          <FeaturesSection />
        </div>
        <div className="landing-fade-in">
          <HowItWorks />
        </div>
        <TechStrip />
        <div className="landing-fade-in">
          <SecuritySection />
        </div>
        <div className="landing-fade-in">
          <PricingSection />
        </div>
        <div className="landing-fade-in">
          <OpenSourceCTA />
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
