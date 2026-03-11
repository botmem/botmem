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
            to="/pricing"
            className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            PRICING
          </Link>
          <span className="text-nb-text font-bold cursor-default">PRIVACY</span>
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
        <div className="flex flex-wrap gap-6">
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
          <span className="text-nb-text cursor-default">Privacy</span>
          <Link
            to="/terms"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            Terms
          </Link>
          <Link
            to="/data-policy"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            Data Policy
          </Link>
        </div>
      </div>
    </footer>
  );
}

interface SectionProps {
  id: string;
  number: string;
  title: string;
  children: React.ReactNode;
}

function PolicySection({ id, number, title, children }: SectionProps) {
  return (
    <section
      id={id}
      className="landing-fade-in bg-nb-surface border-3 border-nb-border shadow-nb p-6 sm:p-8"
      aria-labelledby={`${id}-heading`}
    >
      <h2
        id={`${id}-heading`}
        className="font-display text-lg sm:text-xl font-bold uppercase tracking-wide"
      >
        <span className="text-nb-lime">{number}.</span> {title}
      </h2>
      <div className="mt-4 font-mono text-sm text-nb-muted leading-relaxed space-y-3">
        {children}
      </div>
    </section>
  );
}

export function PrivacyPage() {
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
          aria-labelledby="privacy-hero-heading"
        >
          <h1
            id="privacy-hero-heading"
            className="font-display text-4xl sm:text-5xl font-bold uppercase leading-[1.1] tracking-tight"
          >
            PRIVACY <span className="text-nb-lime">POLICY</span>
          </h1>
          <p className="mt-6 font-mono text-lg text-nb-muted leading-relaxed max-w-xl mx-auto">
            Your data is yours. We built Botmem to keep it that way.
          </p>
          <p className="mt-3 font-mono text-xs text-nb-muted">Last updated: March 2026</p>
        </section>

        {/* Policy sections */}
        <div className="px-4 sm:px-6 pb-20 max-w-3xl mx-auto space-y-6">
          <PolicySection id="information-we-collect" number="01" title="INFORMATION WE COLLECT">
            <p>We collect the following categories of information:</p>
            <ul className="list-none space-y-2 pl-4">
              <li>
                <strong className="text-nb-text">Account information</strong> &mdash; your email
                address and a hashed password. We never store your password in plaintext.
              </li>
              <li>
                <strong className="text-nb-text">Connector data</strong> &mdash; when you connect
                services like Gmail, Slack, WhatsApp, iMessage, or Photos, we ingest emails,
                messages, photos, locations, and contact information from those services at your
                direction.
              </li>
              <li>
                <strong className="text-nb-text">Usage analytics</strong> &mdash; we use PostHog to
                collect anonymous usage data such as page views and feature usage. This helps us
                understand how to improve the product. No connector data is sent to PostHog.
              </li>
            </ul>
          </PolicySection>

          <PolicySection id="how-we-use" number="02" title="HOW WE USE YOUR INFORMATION">
            <p>We use your information for the following purposes:</p>
            <ul className="list-none space-y-2 pl-4">
              <li>
                <strong className="text-nb-text">Providing the service</strong> &mdash; ingesting,
                normalizing, enriching, and indexing your memories so you can search and retrieve
                them.
              </li>
              <li>
                <strong className="text-nb-text">Improving the product</strong> &mdash; analyzing
                aggregate, anonymized usage patterns to build better features.
              </li>
              <li>
                <strong className="text-nb-text">Service communications</strong> &mdash; sending
                critical emails about your account, security alerts, or material changes to the
                service. We do not send marketing emails.
              </li>
            </ul>
          </PolicySection>

          <PolicySection id="data-storage" number="03" title="DATA STORAGE & SECURITY">
            <p>
              All sensitive data is encrypted at rest using{' '}
              <strong className="text-nb-text">AES-256-GCM</strong>. Your connector credentials,
              OAuth tokens, and memory data are encrypted before being written to the database.
            </p>
            <p>
              Botmem uses a <strong className="text-nb-text">recovery key system</strong> for
              encryption. Your recovery key is generated on signup and shown to you once. We store
              only a SHA-256 hash of this key &mdash; we never have access to the key itself. This
              means we cannot decrypt your data, even if compelled to.
            </p>
            <p>
              Data is stored on secured infrastructure with encrypted disks, restricted network
              access, and regular security updates.
            </p>
          </PolicySection>

          <PolicySection id="self-hosted-vs-pro" number="04" title="SELF-HOSTED VS PRO">
            <div className="space-y-4">
              <div>
                <h3 className="font-display text-sm font-bold text-nb-text uppercase tracking-wide mb-2">
                  Self-hosted (Free)
                </h3>
                <p>
                  All data stays on your hardware. You control the database, the encryption keys,
                  and the infrastructure. Zero telemetry is sent by default &mdash; you opt in to
                  analytics if you choose.
                </p>
              </div>
              <div>
                <h3 className="font-display text-sm font-bold text-nb-text uppercase tracking-wide mb-2">
                  Pro ($14.99/mo)
                </h3>
                <p>
                  Your data is hosted on our managed infrastructure. All data is encrypted at rest
                  with your recovery key. Because we never store your recovery key, we cannot read
                  your encrypted data. You retain full ownership and can export or delete at any
                  time.
                </p>
              </div>
            </div>
          </PolicySection>

          <PolicySection id="third-party" number="05" title="THIRD-PARTY SERVICES">
            <p>Botmem integrates with the following third-party services:</p>
            <ul className="list-none space-y-2 pl-4">
              <li>
                <strong className="text-nb-text">Connector OAuth providers</strong> &mdash; Google
                (Gmail), Slack, and WhatsApp for authentication and data access. These services have
                their own privacy policies.
              </li>
              <li>
                <strong className="text-nb-text">PostHog</strong> &mdash; for product analytics.
                PostHog receives anonymous usage events, never your personal data or memories.
              </li>
              <li>
                <strong className="text-nb-text">AI processing</strong> &mdash; Ollama (self-hosted
                default) or OpenRouter (cloud option) for embedding generation and text enrichment.
                When using Ollama, no data leaves your network. When using OpenRouter, text snippets
                are sent for processing under their data processing terms.
              </li>
            </ul>
          </PolicySection>

          <PolicySection id="data-retention" number="06" title="DATA RETENTION">
            <p>
              We retain your data for as long as your account is active. If you delete your account,
              all associated data &mdash; memories, contacts, connector credentials, raw events, and
              vectors &mdash; are permanently deleted from our systems. There is no soft delete.
            </p>
            <p>
              Backups that contain your encrypted data are rotated and permanently destroyed within
              30 days of account deletion.
            </p>
          </PolicySection>

          <PolicySection id="your-rights" number="07" title="YOUR RIGHTS">
            <p>You have the right to:</p>
            <ul className="list-none space-y-2 pl-4">
              <li>
                <strong className="text-nb-text">Export all your data</strong> &mdash; download a
                complete copy of your memories, contacts, and metadata at any time via the API or
                CLI.
              </li>
              <li>
                <strong className="text-nb-text">Delete your account</strong> &mdash; permanently
                remove all data from our systems. This action is irreversible.
              </li>
              <li>
                <strong className="text-nb-text">Opt out of analytics</strong> &mdash; disable
                PostHog tracking in your account settings. Self-hosted users have analytics disabled
                by default.
              </li>
            </ul>
          </PolicySection>

          <PolicySection id="cookies" number="08" title="COOKIES">
            <p>We use minimal cookies, strictly for functionality:</p>
            <ul className="list-none space-y-2 pl-4">
              <li>
                <strong className="text-nb-text">Session authentication</strong> &mdash; a secure,
                httpOnly cookie to maintain your login session.
              </li>
              <li>
                <strong className="text-nb-text">PostHog analytics</strong> &mdash; a cookie to
                track anonymous usage. This cookie is not set if you opt out of analytics.
              </li>
            </ul>
            <p>
              We do not use advertising cookies, tracking pixels, or third-party marketing cookies.
            </p>
          </PolicySection>

          <PolicySection id="changes" number="09" title="CHANGES TO THIS POLICY">
            <p>
              If we make material changes to this privacy policy, we will notify you via email at
              the address associated with your account at least 30 days before the changes take
              effect. Non-material changes (such as formatting or clarifications) may be made
              without notice.
            </p>
            <p>
              You can always find the current version of this policy at{' '}
              <Link to="/privacy" className="text-nb-lime hover:underline">
                botmem.xyz/privacy
              </Link>
              .
            </p>
          </PolicySection>

          <PolicySection id="contact" number="10" title="CONTACT">
            <p>
              If you have questions about this privacy policy or how we handle your data, contact us
              at:
            </p>
            <p>
              <a
                href="mailto:amroessams@gmail.com"
                className="text-nb-lime hover:underline font-bold"
              >
                amroessams@gmail.com
              </a>
            </p>
          </PolicySection>
        </div>
      </main>
      <Footer />
    </div>
  );
}
