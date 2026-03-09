import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';

const GITHUB_URL = 'https://github.com/botmem/open-core';

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
          <a
            href="#features"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            FEATURES
          </a>
          <a
            href="#how-it-works"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            HOW IT WORKS
          </a>
          <a
            href="#open-source"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            OPEN SOURCE
          </a>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link
            to="/signup"
            className="font-display text-sm font-bold px-5 py-2 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer"
          >
            GET STARTED
          </Link>
        </div>
      </div>
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
        <span className="w-3 h-3 bg-nb-red border border-nb-border" />
        <span className="w-3 h-3 bg-nb-yellow border border-nb-border" />
        <span className="w-3 h-3 bg-nb-green border border-nb-border" />
        <span className="ml-2 text-nb-muted text-xs">botmem</span>
      </div>
      <div className="p-4 sm:p-5 space-y-3 text-[13px] leading-relaxed">
        <div>
          <span className="text-nb-lime">$</span>{' '}
          <span className="text-nb-text">
            botmem search &quot;dinner with sarah last month&quot;
          </span>
        </div>
        <div className="text-nb-muted">Searching 12,847 memories...</div>
        <div className="border-t border-nb-border/30 pt-3 space-y-3">
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

function HowItWorks() {
  const steps = [
    { cmd: 'docker compose up -d', result: 'Redis, Qdrant, Ollama running' },
    { cmd: 'Connect Gmail, Slack, ...', result: 'Data syncing → embedding → enriching' },
    { cmd: 'botmem search "dinner"', result: 'Ranked results in 48ms' },
  ];
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
          HOW IT WORKS
        </h2>
        <div className="mt-12 bg-nb-surface border-3 border-nb-border shadow-nb-lg font-mono text-sm overflow-hidden max-w-2xl mx-auto">
          <div className="flex items-center gap-2 px-4 py-2 border-b-3 border-nb-border bg-nb-bg">
            <span className="w-3 h-3 bg-nb-red border border-nb-border" />
            <span className="w-3 h-3 bg-nb-yellow border border-nb-border" />
            <span className="w-3 h-3 bg-nb-green border border-nb-border" />
            <span className="ml-2 text-nb-muted text-xs">terminal</span>
          </div>
          <div className="p-5 space-y-5">
            {steps.map((s, i) => (
              <div key={i}>
                <div>
                  <span className="text-nb-muted font-bold">{i + 1}.</span>{' '}
                  <span className="text-nb-lime">$</span>{' '}
                  <span className="text-nb-text">{s.cmd}</span>
                </div>
                <div className="text-nb-muted ml-5 mt-1">→ {s.result}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TechStrip() {
  const techs = ['NestJS', 'SQLite', 'Qdrant', 'Ollama', 'React', 'BullMQ'];
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

function Footer() {
  return (
    <footer className="border-t-4 border-nb-border py-8 px-4 sm:px-6">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-sm text-nb-muted">
        <Logo variant="full" height={24} />
        <div className="flex gap-6">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            GitHub
          </a>
          <a
            href={`${GITHUB_URL}#readme`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            Docs
          </a>
        </div>
      </div>
    </footer>
  );
}

export function LandingPage() {
  const mainRef = useRef<HTMLDivElement>(null);

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
          <OpenSourceCTA />
        </div>
      </main>
      <Footer />
    </div>
  );
}
