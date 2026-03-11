import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';

const GITHUB_URL = 'https://github.com/botmem/botmem';

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
          <Link
            to="/#features"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            FEATURES
          </Link>
          <Link
            to="/#how-it-works"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            HOW IT WORKS
          </Link>
          <Link
            to="/#open-source"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            OPEN SOURCE
          </Link>
          <Link
            to="/pricing"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            PRICING
          </Link>
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
          <Link
            to="/pricing"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            Pricing
          </Link>
          <span className="text-nb-text cursor-default">Data Policy</span>
        </div>
      </div>
    </footer>
  );
}

function SectionCard({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="landing-fade-in bg-nb-surface border-3 border-nb-border shadow-nb p-6 sm:p-8"
      aria-labelledby={`${id}-heading`}
    >
      <div className="flex items-start gap-4">
        <span className="font-display text-2xl font-bold text-nb-lime shrink-0">{number}</span>
        <div className="flex-1 min-w-0">
          <h2
            id={`${id}-heading`}
            className="font-display text-lg sm:text-xl font-bold uppercase tracking-wide"
          >
            {title}
          </h2>
          <div className="mt-4 font-mono text-sm text-nb-muted leading-relaxed space-y-3">
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

function PipelineStep({
  label,
  description,
  isLast,
}: {
  label: string;
  description: string;
  isLast?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col items-center shrink-0">
        <div className="w-3 h-3 bg-nb-lime border-2 border-nb-border mt-1" />
        {!isLast && <div className="w-0.5 h-8 bg-nb-border" />}
      </div>
      <div>
        <span className="font-display text-sm font-bold tracking-wide text-nb-text">{label}</span>
        <p className="font-mono text-sm text-nb-muted">{description}</p>
      </div>
    </div>
  );
}

export function DataPolicyPage() {
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
      <Navbar />
      <main id="main-content">
        {/* Hero */}
        <section
          className="px-4 sm:px-6 pt-20 pb-12 max-w-6xl mx-auto text-center"
          aria-labelledby="data-policy-hero-heading"
        >
          <h1
            id="data-policy-hero-heading"
            className="font-display text-4xl sm:text-5xl font-bold uppercase leading-[1.1] tracking-tight"
          >
            DATA <span className="text-nb-lime">POLICY</span>
          </h1>
          <p className="mt-6 font-mono text-lg text-nb-muted leading-relaxed max-w-2xl mx-auto">
            How Botmem handles, encrypts, and protects your data. No legalese &mdash; just the
            technical truth.
          </p>
          <p className="mt-2 font-mono text-xs text-nb-muted">Last updated: March 2026</p>
        </section>

        {/* Sections */}
        <div className="px-4 sm:px-6 pb-20 max-w-4xl mx-auto space-y-6">
          {/* 01 - Philosophy */}
          <SectionCard id="philosophy" number="01" title="OUR PHILOSOPHY">
            <p>
              <strong className="text-nb-text">
                Store everything, label confidence, encrypt by default.
              </strong>
            </p>
            <p>
              Your data is yours. We built Botmem to be transparent about exactly how your data
              flows through every layer of the system. Every memory is stored, never silently
              deleted, and classified with a factuality label:{' '}
              <strong className="text-nb-text">FACT</strong>,{' '}
              <strong className="text-nb-text">UNVERIFIED</strong>, or{' '}
              <strong className="text-nb-text">FICTION</strong>. You always know what the system
              knows and how confident it is.
            </p>
          </SectionCard>

          {/* 02 - Data Flow */}
          <SectionCard id="data-flow" number="02" title="DATA FLOW">
            <p>
              Every piece of data follows the same pipeline from connector to searchable memory:
            </p>
            <div className="mt-4 space-y-0">
              <PipelineStep
                label="CONNECTOR SYNC"
                description="Data pulled from source (Gmail, Slack, WhatsApp, iMessage, Photos, Locations) via authenticated connector."
              />
              <PipelineStep
                label="RAW EVENTS"
                description="Immutable payload stored in PostgreSQL. The original data is never modified."
              />
              <PipelineStep
                label="EMBEDDING"
                description="Text content is vectorized into a 1024-dimensional embedding and stored in Qdrant for semantic search."
              />
              <PipelineStep
                label="ENRICHMENT"
                description="AI extracts entities, claims, and classifies factuality. Importance scores computed. Contacts resolved and deduplicated."
              />
              <PipelineStep
                label="SEARCHABLE MEMORY"
                description="Fully indexed memory with weighted ranking: 40% semantic, 30% rerank, 15% recency, 10% importance, 5% trust."
                isLast
              />
            </div>
          </SectionCard>

          {/* 03 - Encryption Architecture */}
          <SectionCard id="encryption" number="03" title="ENCRYPTION ARCHITECTURE">
            <p>
              All sensitive data is encrypted at rest using{' '}
              <strong className="text-nb-text">AES-256-GCM</strong>, the same standard used in
              banking and government systems.
            </p>
            <div className="mt-4 bg-nb-bg border-3 border-nb-border p-4 space-y-2">
              <p className="font-display text-sm font-bold text-nb-text tracking-wide">
                RECOVERY KEY SYSTEM
              </p>
              <ul className="list-none space-y-2">
                <li>
                  On signup, a random{' '}
                  <strong className="text-nb-text">32-byte encryption key</strong> is generated and
                  shown to you once as a base64 string.
                </li>
                <li>
                  Only the <strong className="text-nb-text">SHA-256 hash</strong> of this key is
                  stored in the database for verification. The plaintext key is never persisted on
                  the server.
                </li>
                <li>
                  The key is temporarily cached in memory and Redis (encrypted with the
                  server&apos;s APP_SECRET, 30-day TTL) for session continuity.
                </li>
                <li>
                  <strong className="text-nb-text">
                    Password changes have zero impact on encryption.
                  </strong>{' '}
                  Your recovery key is independent of your password. Changing or resetting your
                  password does not re-encrypt anything.
                </li>
              </ul>
            </div>
            <p className="mt-3">
              Your recovery key <em>is</em> your encryption key. Lose it, and encrypted credentials
              cannot be recovered. This is by design.
            </p>
          </SectionCard>

          {/* 04 - What We Encrypt */}
          <SectionCard id="what-encrypted" number="04" title="WHAT WE ENCRYPT">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="bg-nb-bg border-3 border-nb-border p-4">
                <p className="font-display text-sm font-bold text-nb-lime tracking-wide mb-2">
                  ENCRYPTED
                </p>
                <ul className="space-y-1.5">
                  <li>Connector OAuth tokens &amp; refresh tokens</li>
                  <li>API keys &amp; credentials</li>
                  <li>Authentication context per account</li>
                  <li>Session credentials (WhatsApp, etc.)</li>
                </ul>
              </div>
              <div className="bg-nb-bg border-3 border-nb-border p-4">
                <p className="font-display text-sm font-bold text-nb-text tracking-wide mb-2">
                  NOT ENCRYPTED (BY DESIGN)
                </p>
                <ul className="space-y-1.5">
                  <li>Memory text content (needed for search)</li>
                  <li>Contact names &amp; identifiers</li>
                  <li>Vector embeddings (needed for similarity)</li>
                  <li>Job metadata &amp; logs</li>
                </ul>
              </div>
            </div>
            <p className="mt-3">
              Memory content and contacts are stored unencrypted because they must be searchable and
              queryable. On self-hosted deployments, disk-level encryption (LUKS, FileVault, etc.)
              is recommended for defense in depth.
            </p>
          </SectionCard>

          {/* 05 - Self-Hosted */}
          <SectionCard id="self-hosted" number="05" title="SELF-HOSTED DATA ISOLATION">
            <p>When you self-host Botmem, your data never leaves your hardware:</p>
            <ul className="list-none space-y-2 mt-2">
              <li>
                <strong className="text-nb-text">All data stays local.</strong> PostgreSQL, Qdrant,
                and Redis run on your infrastructure.
              </li>
              <li>
                <strong className="text-nb-text">AI processing via local Ollama.</strong> Embedding
                and enrichment models run on your machine. No data sent to external APIs.
              </li>
              <li>
                <strong className="text-nb-text">No telemetry.</strong> No analytics, no tracking
                pixels, no phone-home. Zero network calls to Botmem servers.
              </li>
              <li>
                <strong className="text-nb-text">You control the encryption keys.</strong> The
                APP_SECRET environment variable is your master secret for encrypting cached
                credentials. You set it, you own it.
              </li>
            </ul>
          </SectionCard>

          {/* 06 - Pro Data Handling */}
          <SectionCard id="pro-data" number="06" title="PRO DATA HANDLING">
            <p>
              On the Pro cloud tier, your data is hosted on managed infrastructure with the
              following guarantees:
            </p>
            <ul className="list-none space-y-2 mt-2">
              <li>
                <strong className="text-nb-text">Encrypted at rest</strong> &mdash; all databases
                and storage volumes use disk-level encryption in addition to application-level
                AES-256-GCM.
              </li>
              <li>
                <strong className="text-nb-text">
                  We cannot decrypt your connector credentials
                </strong>{' '}
                without your recovery key. The server only caches the key while your session is
                active.
              </li>
              <li>
                <strong className="text-nb-text">Automatic backups</strong> &mdash; daily encrypted
                backups with 30-day retention. Backups are encrypted with separate infrastructure
                keys.
              </li>
              <li>
                <strong className="text-nb-text">No data sharing.</strong> We never access, analyze,
                sell, or share your data. Your memories are yours.
              </li>
            </ul>
          </SectionCard>

          {/* 07 - AI Processing */}
          <SectionCard id="ai-processing" number="07" title="AI PROCESSING">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="bg-nb-bg border-3 border-nb-border p-4">
                <p className="font-display text-sm font-bold text-nb-lime tracking-wide mb-2">
                  SELF-HOSTED (OLLAMA)
                </p>
                <ul className="space-y-1.5">
                  <li>
                    <strong className="text-nb-text">Embedding:</strong> mxbai-embed-large (1024d)
                  </li>
                  <li>
                    <strong className="text-nb-text">Text:</strong> qwen3:8b
                  </li>
                  <li>
                    <strong className="text-nb-text">Vision:</strong> qwen3-vl:4b
                  </li>
                  <li className="mt-2 text-nb-text">
                    All models run locally. Nothing leaves your network.
                  </li>
                </ul>
              </div>
              <div className="bg-nb-bg border-3 border-nb-border p-4">
                <p className="font-display text-sm font-bold text-nb-text tracking-wide mb-2">
                  PRO (CLOUD MODELS)
                </p>
                <ul className="space-y-1.5">
                  <li>Optimized cloud models for faster enrichment.</li>
                  <li>
                    Only text content is sent for processing &mdash; never credentials, tokens, or
                    encryption keys.
                  </li>
                  <li className="mt-2 text-nb-text">Models are configurable in both tiers.</li>
                </ul>
              </div>
            </div>
          </SectionCard>

          {/* 08 - Data Deletion */}
          <SectionCard id="deletion" number="08" title="DATA DELETION">
            <p>
              When you delete your account,{' '}
              <strong className="text-nb-text">all data is permanently purged</strong>:
            </p>
            <ul className="list-none space-y-1.5 mt-2">
              <li>PostgreSQL records (memories, contacts, raw events, jobs, accounts)</li>
              <li>Qdrant vector embeddings</li>
              <li>Redis cache (sessions, encryption key cache)</li>
              <li>All raw event payloads</li>
            </ul>
            <p className="mt-3">
              This is <strong className="text-nb-text">irreversible</strong>. There is no
              soft-delete, no 30-day grace period, no recovery after deletion. Export your data
              first if you need it.
            </p>
          </SectionCard>

          {/* 09 - Open Source Verification */}
          <SectionCard id="open-source" number="09" title="OPEN SOURCE VERIFICATION">
            <p>
              Every line of encryption code, every data pipeline, every connector &mdash; it&apos;s
              all open-source under the MIT license. You don&apos;t have to trust our words. Read
              the code.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-display text-sm font-bold px-6 py-2.5 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
              >
                VIEW ON GITHUB
              </a>
              <a
                href={`${GITHUB_URL}/tree/main/apps/api/src/memory`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-display text-sm font-bold px-6 py-2.5 bg-transparent text-nb-text border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none hover:bg-nb-surface active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer inline-block"
              >
                ENCRYPTION SOURCE
              </a>
            </div>
            <p className="mt-4 text-nb-text font-bold">
              Don&apos;t trust us &mdash; read the code.
            </p>
          </SectionCard>
        </div>
      </main>
      <Footer />
    </div>
  );
}
