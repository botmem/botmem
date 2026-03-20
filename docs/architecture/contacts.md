# Contact Resolution

::: info Naming Convention
The user-facing domain concept is "contacts," but the codebase uses `people` as the canonical name. The API module is `people/`, database tables are `people`, `personIdentifiers`, and `memoryPeople`, and the Drizzle schema exports match. Documentation uses "contacts" for clarity.
:::

Contacts are a first-class entity in Botmem. The system automatically identifies, deduplicates, and merges people across all connected data sources.

## How Contact Resolution Works

When the embed processor encounters a memory with participants (email senders, chat usernames, photo face tags), it resolves each participant to a contact record.

### Resolution Flow

```
Memory participant: "john@acme.com"
  |
  v
Search contact_identifiers for:
  type=email, value=john@acme.com
  |
  +-- Found? --> Use existing contact
  |
  +-- Not found? --> Create new contact
      |
      v
  Link memory <-> contact with role (sender/recipient/participant)
```

### Identifier Types

| Type               | Description                          | Connectors                        |
| ------------------ | ------------------------------------ | --------------------------------- |
| `email`            | Email address                        | Gmail, Slack, iMessage            |
| `phone`            | Phone number                         | WhatsApp, Gmail (contacts), Slack |
| `slack_id`         | Slack username or user ID            | Slack                             |
| `imessage_handle`  | iMessage identifier (email or phone) | iMessage                          |
| `immich_person_id` | Immich facial recognition person ID  | Photos/Immich                     |
| `name`             | Display name                         | All connectors                    |
| `sip`              | SIP address                          | Gmail (contacts)                  |

### Resolution Rules

1. **Email matching** -- two participants with the same email are the same contact
2. **Phone matching** -- two participants with the same phone number are the same contact
3. **Slack ID matching** -- a Slack username maps to a specific contact
4. **Name skipping** -- `name` type identifiers are **not** used for matching to prevent false merges (e.g., two different people named "John")
5. **Case-insensitive** -- email matching is case-insensitive (normalized to lowercase)

## Cross-Connector Merging

The real power of contacts emerges when the same person appears across multiple connectors:

```
Gmail: "John Smith" <john@acme.com>
  --> Contact: John Smith
      Identifier: email=john@acme.com (gmail)
      Identifier: name=John Smith (gmail)

Slack: @johnsmith (email: john@acme.com, phone: +14155551234)
  --> Same contact (matched on email)
      + Identifier: slack_id=johnsmith (slack)
      + Identifier: phone=+14155551234 (slack)

WhatsApp: +14155551234 (push name: John)
  --> Same contact (matched on phone)
      + Identifier: phone=+14155551234 (whatsapp)

Photos/Immich: Face tag "John Smith" (person ID: abc-123)
  --> Separate contact initially (name-only match skipped)
      Can be manually merged via merge suggestions
```

## Contact Data Model

### contacts table

```typescript
interface Contact {
  id: string; // UUID
  displayName: string; // Primary display name
  avatars: string; // JSON: [{url, source}]
  metadata: string; // JSON: {organizations, birthday, addresses, ...}
  createdAt: string;
  updatedAt: string;
}
```

### contact_identifiers table

```typescript
interface ContactIdentifier {
  id: string;
  contactId: string; // FK to contacts
  identifierType: string; // email, phone, slack_id, etc.
  identifierValue: string;
  connectorType: string; // Which connector provided this
  confidence: number; // 0.0 - 1.0
  createdAt: string;
}
```

### memory_contacts table

```typescript
interface MemoryContact {
  id: string;
  memoryId: string; // FK to memories
  contactId: string; // FK to contacts
  role: string; // sender, recipient, mentioned, participant
}
```

## Rich Contact Metadata

Connectors enrich contacts with all available metadata:

### From Gmail (Google Contacts)

- Organizations (company, title, department)
- Addresses (home, work)
- Birthday
- URLs (website, social profiles)
- Relations (spouse, parent, etc.)
- Occupations
- Gender
- IM clients
- External IDs
- Profile photos (stored as base64 avatars)

### From Slack

- Real name, display name
- Email, phone
- Job title
- Profile photo

### From Immich

- Face recognition person ID
- Face thumbnail (stored as base64 avatar)

## Merge Suggestions

Botmem detects potential duplicate contacts and suggests merges:

```bash
# Get merge suggestions
curl http://localhost:12412/api/contacts/suggestions
```

Suggestions are based on:

- Similar display names (fuzzy matching)
- Shared identifiers across different connector types
- Common memory associations

### Manual Merge

```bash
# Merge contact B into contact A
curl -X POST http://localhost:12412/api/contacts/<contact-a-id>/merge \
  -H 'Content-Type: application/json' \
  -d '{"sourceId": "<contact-b-id>"}'
```

Merging:

1. Moves all identifiers from source to target
2. Re-links all memory associations
3. Merges metadata (target fields take precedence)
4. Deletes the source contact

### Dismiss Suggestions

If two contacts are genuinely different people:

```bash
curl -X POST http://localhost:12412/api/contacts/suggestions/dismiss \
  -H 'Content-Type: application/json' \
  -d '{"contactId1": "<id-1>", "contactId2": "<id-2>"}'
```

Dismissed pairs are stored in the `merge_dismissals` table and will not be suggested again.

## Email Normalization

To prevent duplicate contacts from email case variations, all email identifiers are normalized to lowercase during resolution:

```
"John.Smith@ACME.com" -> "john.smith@acme.com"
```

This ensures that the same email address from different sources always resolves to the same contact.
