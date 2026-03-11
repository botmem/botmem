import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import { PublicNavbar } from '../components/layout/PublicNavbar';
import { PublicFooter } from '../components/layout/PublicFooter';

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

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

const FREE_FEATURES = [
  'All 6 connectors (Gmail, Slack, WhatsApp, iMessage, Photos, Locations)',
  'Unlimited memories',
  'Local AI enrichment via Ollama',
  'Contact graph with auto-deduplication',
  'Memory graph visualization',
  'Factuality classification (FACT / UNVERIFIED / FICTION)',
  'CLI + REST + WebSocket API',
  'BullMQ job queue',
  'Community support via GitHub',
];

const PRO_FEATURES = [
  'Everything in Free',
  'Cloud-hosted infrastructure (zero setup)',
  'Managed PostgreSQL, Qdrant, and Redis',
  'Priority enrichment pipeline',
  'Advanced analytics dashboard',
  'Full API access with webhooks',
  'Automatic daily backups',
  'Email support with 24h response time',
  'Early access to new connectors',
];

const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: 'IS MY DATA ENCRYPTED?',
    a: 'Yes. All credentials and sensitive data are encrypted at rest with AES-256-GCM. On Pro, your data is encrypted in transit and at rest on our infrastructure. On self-hosted, you control the encryption keys.',
  },
  {
    q: 'CAN I SWITCH FROM SELF-HOSTED TO PRO?',
    a: 'Yes. Export your data from your self-hosted instance and import it into Pro. We provide migration tools to make the switch seamless.',
  },
  {
    q: 'WHAT HAPPENS IF I CANCEL PRO?',
    a: 'You keep all your data. Export it anytime and continue self-hosting with the same open-source code. No lock-in, no data hostage.',
  },
  {
    q: 'WHAT AI MODELS DO YOU USE?',
    a: 'Self-hosted uses Ollama with configurable models (default: qwen3:8b for text, mxbai-embed-large for embeddings). Pro uses optimized cloud models for faster enrichment. You can configure the models in both tiers.',
  },
  {
    q: 'IS THERE A LIMIT ON CONNECTORS?',
    a: 'No. Both Free and Pro support all connectors with no limits on the number of accounts you connect or memories you store.',
  },
  {
    q: 'DO YOU SELL MY DATA?',
    a: 'Never. Botmem is open-source and your data is yours. On Pro, we host it for you but never access, analyze, or sell it. On self-hosted, your data never leaves your hardware.',
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-nb-surface border-3 border-nb-border shadow-nb">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-6 py-4 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-nb-lime"
        aria-expanded={open}
      >
        <span className="font-display text-sm font-bold tracking-wide">{q}</span>
        <ChevronIcon open={open} />
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-200',
          open ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <div className="px-6 pb-5">
          <p className="font-mono text-sm text-nb-muted leading-relaxed">{a}</p>
        </div>
      </div>
    </div>
  );
}

export function PricingPage() {
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
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-nb-lime focus:text-black focus:font-display focus:font-bold focus:border-3 focus:border-nb-border focus:shadow-nb"
      >
        Skip to content
      </a>
      <PublicNavbar />
      <main id="main-content">
        {/* Hero */}
        <section
          className="px-4 sm:px-6 pt-20 pb-12 max-w-6xl mx-auto text-center"
          aria-labelledby="pricing-hero-heading"
        >
          <h1
            id="pricing-hero-heading"
            className="font-display text-4xl sm:text-5xl font-bold uppercase leading-[1.1] tracking-tight"
          >
            SIMPLE, <span className="text-nb-lime">HONEST</span> PRICING
          </h1>
          <p className="mt-6 font-mono text-lg text-nb-muted leading-relaxed max-w-xl mx-auto">
            Self-host for free or let us handle everything. Same open-source code, your choice.
          </p>
        </section>

        {/* Pricing cards */}
        <div className="landing-fade-in">
          <section className="px-4 sm:px-6 pb-20 max-w-4xl mx-auto" aria-label="Pricing tiers">
            <div className="grid sm:grid-cols-2 gap-6">
              {/* Free tier */}
              <div className="bg-nb-surface border-3 border-nb-border p-8 shadow-nb flex flex-col">
                <div className="mb-6">
                  <h2 className="font-display text-xl font-bold tracking-wide uppercase">FREE</h2>
                  <div className="mt-3 flex items-baseline gap-1">
                    <span className="font-display text-5xl font-bold">$0</span>
                    <span className="font-mono text-sm text-nb-muted">/forever</span>
                  </div>
                  <p className="font-mono text-sm text-nb-muted mt-3 leading-relaxed">
                    Self-hosted on your hardware. Full control over your data and infrastructure.
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
              <div className="bg-nb-surface border-3 border-nb-lime p-8 shadow-nb flex flex-col relative">
                <div className="absolute -top-4 right-4 bg-nb-lime text-black font-display text-xs font-bold px-3 py-1 border-3 border-nb-border">
                  RECOMMENDED
                </div>
                <div className="mb-6">
                  <h2 className="font-display text-xl font-bold tracking-wide uppercase text-nb-lime">
                    PRO
                  </h2>
                  <div className="mt-3 flex items-baseline gap-1">
                    <span className="font-display text-5xl font-bold">$14.99</span>
                    <span className="font-mono text-sm text-nb-muted">/month</span>
                  </div>
                  <p className="font-mono text-sm text-nb-muted mt-3 leading-relaxed">
                    We handle the infrastructure. You keep the memories. Zero maintenance.
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
          </section>
        </div>

        {/* FAQ */}
        <div className="landing-fade-in">
          <section
            className="px-4 sm:px-6 py-20 border-t-4 border-nb-border"
            aria-labelledby="faq-heading"
          >
            <div className="max-w-3xl mx-auto">
              <h2
                id="faq-heading"
                className="font-display text-3xl sm:text-4xl font-bold uppercase text-center"
              >
                FREQUENTLY ASKED <span className="text-nb-lime">QUESTIONS</span>
              </h2>
              <div className="mt-12 flex flex-col gap-4">
                {FAQ_ITEMS.map((item) => (
                  <FaqItem key={item.q} q={item.q} a={item.a} />
                ))}
              </div>
            </div>
          </section>
        </div>

        {/* Bottom CTA */}
        <div className="landing-fade-in">
          <section className="px-4 sm:px-6 py-24" aria-labelledby="cta-heading">
            <div className="max-w-3xl mx-auto text-center">
              <h2
                id="cta-heading"
                className="font-display text-3xl sm:text-4xl font-bold uppercase"
              >
                READY TO <span className="text-nb-lime">REMEMBER</span> EVERYTHING?
              </h2>
              <p className="font-mono text-sm text-nb-muted mt-4 max-w-lg mx-auto leading-relaxed">
                Start with the free self-hosted version or jump straight to Pro. Either way, your
                memories are yours.
              </p>
              <div className="mt-10 flex flex-wrap justify-center gap-4">
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-display text-sm font-bold px-8 py-3 bg-transparent text-nb-text border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none hover:bg-nb-surface active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
                >
                  SELF-HOST FREE
                </a>
                <Link
                  to="/signup"
                  className="font-display text-sm font-bold px-8 py-3 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
                >
                  START PRO
                </Link>
              </div>
            </div>
          </section>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
