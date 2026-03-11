import { useEffect, useRef } from 'react';
import { PublicNavbar } from '../components/layout/PublicNavbar';
import { PublicFooter } from '../components/layout/PublicFooter';

const GITHUB_URL = 'https://github.com/botmem/botmem';

interface SectionProps {
  id: string;
  number: string;
  title: string;
  children: React.ReactNode;
}

function Section({ id, number, title, children }: SectionProps) {
  return (
    <section
      id={id}
      className="landing-fade-in bg-nb-surface border-3 border-nb-border shadow-nb p-6 sm:p-8"
      aria-labelledby={`${id}-heading`}
    >
      <h2
        id={`${id}-heading`}
        className="font-display text-lg sm:text-xl font-bold tracking-wide uppercase"
      >
        <span className="text-nb-lime">{number}.</span> {title}
      </h2>
      <div className="mt-4 font-mono text-sm text-nb-muted leading-relaxed flex flex-col gap-3">
        {children}
      </div>
    </section>
  );
}

export function TermsPage() {
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
          className="px-4 sm:px-6 pt-20 pb-12 max-w-4xl mx-auto text-center"
          aria-labelledby="terms-hero-heading"
        >
          <h1
            id="terms-hero-heading"
            className="font-display text-4xl sm:text-5xl font-bold uppercase leading-[1.1] tracking-tight"
          >
            TERMS OF <span className="text-nb-lime">SERVICE</span>
          </h1>
          <p className="mt-6 font-mono text-lg text-nb-muted leading-relaxed max-w-xl mx-auto">
            The rules of the road for using Botmem.
          </p>
          <p className="mt-3 font-mono text-sm text-nb-muted">Last updated: March 2026</p>
        </section>

        {/* Table of contents */}
        <div className="landing-fade-in">
          <nav className="px-4 sm:px-6 pb-12 max-w-4xl mx-auto" aria-label="Table of contents">
            <div className="bg-nb-surface border-3 border-nb-border shadow-nb p-6 sm:p-8">
              <h2 className="font-display text-lg font-bold tracking-wide uppercase mb-4">
                CONTENTS
              </h2>
              <ol className="grid sm:grid-cols-2 gap-2 font-mono text-sm">
                {[
                  ['acceptance', 'Acceptance of Terms'],
                  ['description', 'Description of Service'],
                  ['accounts', 'Accounts'],
                  ['open-source', 'Open Source License'],
                  ['pro-terms', 'Pro Service Terms'],
                  ['acceptable-use', 'Acceptable Use'],
                  ['data-ownership', 'Data Ownership'],
                  ['intellectual-property', 'Intellectual Property'],
                  ['availability', 'Service Availability'],
                  ['liability', 'Limitation of Liability'],
                  ['termination', 'Termination'],
                  ['governing-law', 'Governing Law'],
                  ['changes', 'Changes to Terms'],
                  ['contact', 'Contact'],
                ].map(([id, label], i) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      className="text-nb-muted hover:text-nb-lime transition-colors duration-200 cursor-pointer"
                    >
                      <span className="text-nb-lime font-bold">
                        {String(i + 1).padStart(2, '0')}.
                      </span>{' '}
                      {label}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </nav>
        </div>

        {/* Sections */}
        <div className="px-4 sm:px-6 pb-20 max-w-4xl mx-auto flex flex-col gap-6">
          <Section id="acceptance" number="01" title="ACCEPTANCE OF TERMS">
            <p>
              By accessing or using Botmem ("the Service"), whether self-hosted or via our Pro cloud
              offering, you agree to be bound by these Terms of Service ("Terms"). If you do not
              agree to these Terms, do not use the Service.
            </p>
            <p>
              These Terms constitute a legally binding agreement between you and Botmem. Your
              continued use of the Service following any modifications to these Terms constitutes
              acceptance of those changes.
            </p>
          </Section>

          <Section id="description" number="02" title="DESCRIPTION OF SERVICE">
            <p>
              Botmem is a personal memory system that ingests events from multiple data sources --
              including emails, messages, photos, and locations -- normalizes them into a unified
              memory schema, and provides cross-modal search and retrieval with weighted ranking.
            </p>
            <p>Key capabilities include:</p>
            <ul className="list-disc list-inside flex flex-col gap-1 ml-2">
              <li>
                Connecting to third-party services (Gmail, Slack, WhatsApp, iMessage, Photos,
                Locations) via pluggable connectors
              </li>
              <li>Local AI-powered enrichment, entity extraction, and factuality classification</li>
              <li>Semantic search and retrieval across all connected data sources</li>
              <li>Contact graph with automatic deduplication across services</li>
            </ul>
          </Section>

          <Section id="accounts" number="03" title="ACCOUNTS">
            <p>
              To use certain features of the Service, you must create an account. When creating an
              account, you agree to:
            </p>
            <ul className="list-disc list-inside flex flex-col gap-1 ml-2">
              <li>Provide accurate and complete registration information</li>
              <li>Keep your credentials secure and not share them with third parties</li>
              <li>Accept responsibility for all activity that occurs under your account</li>
              <li>Notify us immediately of any unauthorized use of your account</li>
            </ul>
            <p>
              You must be at least 16 years of age to use the Service. By creating an account, you
              represent that you meet this age requirement.
            </p>
          </Section>

          <Section id="open-source" number="04" title="OPEN SOURCE LICENSE">
            <p>
              The self-hosted version of Botmem is released under the{' '}
              <a
                href={`${GITHUB_URL}/blob/main/LICENSE`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-nb-lime hover:underline cursor-pointer"
              >
                MIT License
              </a>
              . You are free to use, modify, and distribute the source code in accordance with that
              license.
            </p>
            <p>
              The MIT License applies to the open-source codebase only. The Pro cloud service is
              subject to the additional terms described in Section 5 below.
            </p>
          </Section>

          <Section id="pro-terms" number="05" title="PRO SERVICE TERMS">
            <p>
              The Botmem Pro cloud service is available on a subscription basis under the following
              terms:
            </p>
            <ul className="list-disc list-inside flex flex-col gap-1 ml-2">
              <li>
                <strong className="text-nb-text">Pricing:</strong> $14.99 per month, billed monthly
              </li>
              <li>
                <strong className="text-nb-text">Free trial:</strong> New subscribers receive a
                14-day free trial. You will not be charged until the trial period ends
              </li>
              <li>
                <strong className="text-nb-text">Cancellation:</strong> You may cancel your
                subscription at any time. Your access continues until the end of the current billing
                period
              </li>
              <li>
                <strong className="text-nb-text">Refunds:</strong> If you cancel within the first 30
                days of a paid subscription, you are eligible for a prorated refund. After 30 days,
                no refunds are issued for partial billing periods
              </li>
              <li>
                <strong className="text-nb-text">Price changes:</strong> We reserve the right to
                modify pricing. You will receive at least 30 days written notice before any price
                increase takes effect
              </li>
            </ul>
          </Section>

          <Section id="acceptable-use" number="06" title="ACCEPTABLE USE">
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc list-inside flex flex-col gap-1 ml-2">
              <li>
                Violate any applicable local, state, national, or international law or regulation
              </li>
              <li>
                Store, transmit, or process illegal content, including but not limited to content
                that exploits minors
              </li>
              <li>
                Abuse the API through excessive requests, automated scraping, or denial-of-service
                attacks
              </li>
              <li>
                Attempt unauthorized access to other users' accounts, data, or any part of the
                Service infrastructure
              </li>
              <li>
                Reverse-engineer, decompile, or disassemble the Pro cloud infrastructure (the
                open-source codebase is not subject to this restriction)
              </li>
              <li>Use the Service to harass, threaten, or harm any individual or entity</li>
            </ul>
            <p>
              We reserve the right to suspend or terminate accounts that violate these acceptable
              use guidelines.
            </p>
          </Section>

          <Section id="data-ownership" number="07" title="DATA OWNERSHIP">
            <p>
              <strong className="text-nb-text">You own your data.</strong> We claim no ownership
              rights over your memories, contacts, connected service data, or any content you
              process through the Service.
            </p>
            <p>
              By using the Service, you grant Botmem a limited, non-exclusive, non-transferable
              license to process your data solely for the purpose of providing, maintaining, and
              improving the Service. This license terminates when you delete your data or close your
              account.
            </p>
            <p>
              We do not sell, rent, or share your personal data with third parties for their
              marketing purposes. On self-hosted deployments, your data never leaves your
              infrastructure.
            </p>
          </Section>

          <Section id="intellectual-property" number="08" title="INTELLECTUAL PROPERTY">
            <p>
              The Botmem name, logo, brand identity, and Pro cloud infrastructure are the property
              of Botmem and are protected by applicable intellectual property laws.
            </p>
            <p>
              The open-source codebase is licensed under the MIT License and may be used in
              accordance with that license. This does not grant any rights to the Botmem trademarks
              or Pro-specific infrastructure.
            </p>
          </Section>

          <Section id="availability" number="09" title="SERVICE AVAILABILITY">
            <p>
              <strong className="text-nb-text">Pro Service:</strong> We make reasonable commercial
              efforts to maintain high availability of the Pro cloud service. However, we do not
              guarantee any specific uptime percentage or provide a formal Service Level Agreement
              (SLA). The Service may be temporarily unavailable for maintenance, updates, or
              circumstances beyond our control.
            </p>
            <p>
              <strong className="text-nb-text">Self-hosted:</strong> If you self-host Botmem, you
              are solely responsible for the availability, performance, and maintenance of your
              deployment.
            </p>
          </Section>

          <Section id="liability" number="10" title="LIMITATION OF LIABILITY">
            <p>
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
              WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF
              MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
            </p>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, BOTMEM SHALL NOT BE LIABLE FOR ANY INDIRECT,
              INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR
              REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL,
              OR OTHER INTANGIBLE LOSSES RESULTING FROM YOUR USE OF THE SERVICE.
            </p>
            <p>
              OUR TOTAL LIABILITY FOR ANY CLAIMS ARISING FROM OR RELATED TO THE SERVICE SHALL NOT
              EXCEED THE AMOUNT YOU PAID TO US IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.
            </p>
          </Section>

          <Section id="termination" number="11" title="TERMINATION">
            <p>
              Either party may terminate this agreement at any time. You may terminate by closing
              your account or ceasing use of the Service.
            </p>
            <p>
              Upon termination of a Pro subscription, you will have 30 days to export your data.
              After this 30-day period, your data will be permanently deleted from our
              infrastructure. We recommend exporting your data before cancelling.
            </p>
            <p>
              We may terminate or suspend your account immediately, without prior notice, if you
              violate these Terms or engage in activity that we determine, in our sole discretion,
              may harm the Service or other users.
            </p>
          </Section>

          <Section id="governing-law" number="12" title="GOVERNING LAW">
            <p>
              These Terms shall be governed by and construed in accordance with the laws of the
              State of Delaware, United States of America, without regard to its conflict of law
              provisions.
            </p>
            <p>
              Any disputes arising from or relating to these Terms or the Service shall be resolved
              in the state or federal courts located in the State of Delaware.
            </p>
          </Section>

          <Section id="changes" number="13" title="CHANGES TO TERMS">
            <p>
              We reserve the right to modify these Terms at any time. For material changes, we will
              provide at least 30 days notice via email or a prominent notice on the Service before
              the changes take effect.
            </p>
            <p>
              Your continued use of the Service after the effective date of any modifications
              constitutes acceptance of the updated Terms. If you do not agree to the modified
              Terms, you must stop using the Service.
            </p>
          </Section>

          <Section id="contact" number="14" title="CONTACT">
            <p>If you have any questions about these Terms, please contact us at:</p>
            <p>
              <a
                href="mailto:amroessams@gmail.com"
                className="text-nb-lime hover:underline cursor-pointer"
              >
                amroessams@gmail.com
              </a>
            </p>
          </Section>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
