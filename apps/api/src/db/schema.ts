import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'), // nullable for migration -- will be set for all rows
    connectorType: text('connector_type').notNull(),
    identifier: text('identifier').notNull(),
    status: text('status').notNull().default('disconnected'),
    schedule: text('schedule').notNull().default('manual'),
    authContext: text('auth_context'), // encrypted JSON -- stays text
    lastCursor: text('last_cursor'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    itemsSynced: integer('items_synced').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_accounts_user_id').on(table.userId)],
);

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id),
  connectorType: text('connector_type').notNull(),
  accountIdentifier: text('account_identifier'),
  memoryBankId: text('memory_bank_id'),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  progress: integer('progress').notNull().default(0),
  total: integer('total').notNull().default(0),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const connectorCredentials = pgTable('connector_credentials', {
  connectorType: text('connector_type').primaryKey(),
  credentials: text('credentials').notNull(), // encrypted JSON -- stays text
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const rawEvents = pgTable(
  'raw_events',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    connectorType: text('connector_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceType: text('source_type').notNull(),
    payload: text('payload').notNull(), // large JSON stored as text
    cleanedText: text('cleaned_text'), // nullable -- set by clean processor
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    jobId: text('job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_raw_events_source_id').on(table.sourceId),
    index('idx_raw_events_job_id').on(table.jobId),
  ],
);

// --- Memory tables ---

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').references(() => accounts.id),
    memoryBankId: text('memory_bank_id'), // nullable for migration -- will be set for all rows
    connectorType: text('connector_type').notNull(),
    sourceType: text('source_type').notNull(), // email | message | photo | location
    sourceId: text('source_id').notNull(),
    text: text('text').notNull(), // encrypted ciphertext -- stays text
    eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
    ingestTime: timestamp('ingest_time', { withTimezone: true }).notNull(),
    factuality: jsonb('factuality')
      .notNull()
      .default({ label: 'UNVERIFIED', confidence: 0.5, rationale: 'Pending evaluation' }),
    weights: jsonb('weights')
      .notNull()
      .default({ semantic: 0, rerank: 0, recency: 0, importance: 0.5, trust: 0.5, final: 0 }),
    entities: text('entities').notNull().default('[]'), // encrypted ciphertext -- stays text
    claims: text('claims').notNull().default('[]'), // encrypted ciphertext -- stays text
    metadata: text('metadata').notNull().default('{}'), // encrypted ciphertext -- stays text
    embeddingStatus: text('embedding_status').notNull().default('pending'), // pending | done | failed
    pinned: boolean('pinned').notNull().default(false),
    recallCount: integer('recall_count').notNull().default(0),
    keyVersion: integer('key_version').notNull().default(0), // 0 = APP_SECRET encrypted, >= 1 = user key
    pipelineComplete: boolean('pipeline_complete').notNull().default(false),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_memories_pipeline_complete').on(table.pipelineComplete),
    index('idx_memories_embedding_status').on(table.embeddingStatus),
    index('idx_memories_event_time').on(table.eventTime),
    index('idx_memories_connector_type').on(table.connectorType),
    index('idx_memories_memory_bank_id').on(table.memoryBankId),
    uniqueIndex('idx_memories_source_dedup').on(table.sourceId, table.connectorType),
  ],
);

export const memoryLinks = pgTable('memory_links', {
  id: text('id').primaryKey(),
  srcMemoryId: text('src_memory_id')
    .notNull()
    .references(() => memories.id),
  dstMemoryId: text('dst_memory_id')
    .notNull()
    .references(() => memories.id),
  linkType: text('link_type').notNull().default('related'), // related | supports | contradicts
  strength: doublePrecision('strength').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// --- Contact tables ---

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'), // nullable for migration -- will be set for all rows
    displayName: text('display_name').notNull(),
    entityType: text('entity_type').notNull().default('person'),
    avatars: jsonb('avatars').notNull().default([]),
    preferredAvatarIndex: integer('preferred_avatar_index').default(0),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_contacts_display_name').on(table.displayName),
    index('idx_contacts_user_id').on(table.userId),
  ],
);

export const contactIdentifiers = pgTable(
  'contact_identifiers',
  {
    id: text('id').primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    identifierType: text('identifier_type').notNull(), // email | phone | slack_id | imessage_handle | name
    identifierValue: text('identifier_value').notNull(),
    connectorType: text('connector_type'),
    confidence: doublePrecision('confidence').notNull().default(1.0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_contact_identifiers_contact_id').on(table.contactId),
    index('idx_contact_identifiers_value').on(table.identifierType, table.identifierValue),
  ],
);

export const memoryContacts = pgTable(
  'memory_contacts',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    role: text('role').notNull(), // sender | recipient | mentioned | participant
  },
  (table) => [
    index('idx_memory_contacts_contact_id').on(table.contactId),
    index('idx_memory_contacts_memory_id').on(table.memoryId),
  ],
);

export const mergeDismissals = pgTable(
  'merge_dismissals',
  {
    id: text('id').primaryKey(),
    contactId1: text('contact_id_1')
      .notNull()
      .references(() => contacts.id),
    contactId2: text('contact_id_2')
      .notNull()
      .references(() => contacts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_merge_dismissals_pair').on(table.contactId1, table.contactId2)],
);

// --- User authentication tables ---

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    onboarded: boolean('onboarded').notNull().default(false),
    encryptionSalt: text('encryption_salt'), // nullable for existing users pre-E2EE
    keyVersion: integer('key_version').notNull().default(1),
    recoveryKeyHash: text('recovery_key_hash'), // SHA-256 hash of recovery key for verification
    firebaseUid: text('firebase_uid').unique(), // nullable — Firebase UID for firebase auth provider users
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('idx_users_firebase_uid').on(table.firebaseUid)],
);

export const refreshTokens = pgTable('refresh_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  family: text('family').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const passwordResets = pgTable('password_resets', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// --- Memory Banks table ---

export const memoryBanks = pgTable(
  'memory_banks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_memory_banks_user_id').on(table.userId)],
);

// --- API Keys table ---

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    lastFour: text('last_four').notNull(),
    memoryBankIds: text('memory_bank_ids'), // nullable JSON text
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_api_keys_user_id').on(table.userId),
    index('idx_api_keys_hash').on(table.keyHash),
  ],
);

// --- Settings table ---

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
