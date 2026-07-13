const OPENAI_DATA_CONTROLS_URL =
  'https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint';

export function PrivacyPage() {
  return (
    <div className="privacy-shell">
      <a className="skip-link" href="#main-content">
        Skip to privacy disclosure
      </a>
      <header className="public-header">
        <a className="wordmark" href="/">
          BOTMEM<span aria-hidden="true">//</span>
          <small>V2</small>
        </a>
        <nav className="public-links" aria-label="Public pages">
          <a className="text-link" href="/pricing">
            Pricing
          </a>
          <a className="text-link" href="/">
            Sign in
          </a>
        </nav>
      </header>

      <main
        id="main-content"
        className="privacy-document"
        aria-labelledby="privacy-heading"
        tabIndex={-1}
      >
        <header className="privacy-intro">
          <p className="eyebrow">PRIVACY / EXECUTABLE DATA BOUNDARIES</p>
          <h1 id="privacy-heading">Your messages stay yours.</h1>
          <p>
            This page describes what the current Botmem product actually processes. It is an
            operational privacy disclosure, not a promise that every source is stored locally.
          </p>
          <p className="privacy-updated">Last updated: 13 July 2026</p>
        </header>

        <section aria-labelledby="hosted-data-heading">
          <p className="privacy-number" aria-hidden="true">
            01
          </p>
          <div>
            <h2 id="hosted-data-heading">Hosted sources</h2>
            <p>
              Gmail, Outlook, and OwnTracks content, metadata, connector credentials, search
              projections, and embeddings are processed by Botmem's hosted service. Connector
              credentials are encrypted at rest and isolated to your workspace. Hosted content is
              not zero-knowledge data: Botmem must decrypt it to sync and search it.
            </p>
          </div>
        </section>

        <section aria-labelledby="local-data-heading">
          <p className="privacy-number" aria-hidden="true">
            02
          </p>
          <div>
            <h2 id="local-data-heading">Device-local sources</h2>
            <p>
              iMessage and WhatsApp corpora and indexes stay on your Mac. The Mac opens an outbound
              authenticated TLS connection. A search query and only the bounded matching result
              payloads transit the relay; Botmem does not persist or log those query or result
              bodies. When the Mac is offline, search says that local results are partial.
            </p>
          </div>
        </section>

        <section aria-labelledby="processors-heading">
          <p className="privacy-number" aria-hidden="true">
            03
          </p>
          <div>
            <h2 id="processors-heading">Specialist processors</h2>
            <ul>
              <li>
                <strong>OpenAI API:</strong> hosted Gmail, Outlook, and OwnTracks text is sent to
                the embeddings endpoint. An ordinary federated search also sends the raw search
                query to that endpoint to search the hosted lane, even when the final response also
                contains local-device results. If a search is explicitly filtered to only iMessage
                or WhatsApp, Botmem skips the hosted lane and does not send that query to OpenAI.
                Botmem does not send local result bodies to OpenAI. OpenAI says API data is not used
                for training by default; default abuse-monitoring logs may retain customer content
                for up to 30 days unless Botmem is approved for and enables an applicable retention
                control. <a href={OPENAI_DATA_CONTROLS_URL}>Read OpenAI's current data controls.</a>
              </li>
              <li>
                <strong>Stripe:</strong> Stripe receives checkout and payment details. Botmem keeps
                the minimum customer, subscription, price, and status identifiers needed to grant or
                revoke access. Botmem never receives card numbers.
              </li>
              <li>
                <strong>Resend:</strong> your account email and delivery metadata are sent to Resend
                solely to deliver one-use sign-in and recovery links.
              </li>
            </ul>
          </div>
        </section>

        <section aria-labelledby="access-heading">
          <p className="privacy-number" aria-hidden="true">
            04
          </p>
          <div>
            <h2 id="access-heading">Access, exports, and agents</h2>
            <p>
              Web sessions use HttpOnly cookies. CLI and MCP clients use named, revocable personal
              access tokens. An export contains hosted account, connector, and memory data; it does
              not silently reach into your Mac for iMessage or WhatsApp content. Export artifacts
              are encrypted, short-lived, and single-download.
            </p>
          </div>
        </section>

        <section aria-labelledby="deletion-heading">
          <p className="privacy-number" aria-hidden="true">
            05
          </p>
          <div>
            <h2 id="deletion-heading">Deletion is explicit</h2>
            <p>
              Requesting account deletion immediately revokes hosted access and connector
              credentials, then queues hosted data erasure. Botmem also queues a deletion notice for
              paired Macs. An online Mac stops its revoked tunnel; the notice does not remotely
              erase the Mac or acknowledge local erasure. Local indexes remain until you explicitly
              choose
              <strong> ERASE LOCAL BOTMEM DATA</strong> in the Mac app or run the confirmed CLI
              erase command. That action removes Botmem's index, configuration, and device key but
              never modifies Messages or WhatsApp source databases. Hosted deletion does not wait
              for an offline Mac. Botmem's encrypted database backups are isolated from normal
              product access and can retain hosted data for up to 30 days before automatic expiry;
              they are used only for disaster recovery. Provider and processor retention rules may
              also continue to apply to copies they hold.
            </p>
          </div>
        </section>

        <aside className="privacy-launch-gate" aria-label="Pre-launch legal review required">
          <strong>PRE-LAUNCH LEGAL GATE</strong>
          <p>
            The operating legal entity, postal address, privacy contact, governing terms, and
            jurisdiction-specific rights must be approved and published before accepting live
            customers. Product behavior and subprocessors above are already stated without hiding
            that gate.
          </p>
        </aside>
      </main>
    </div>
  );
}
