import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  connectorType: text('connector_type').notNull(),
  identifier: text('identifier').notNull(),
  status: text('status').notNull().default('disconnected'),
  schedule: text('schedule').notNull().default('manual'),
  authContext: text('auth_context'), // encrypted JSON
  lastCursor: text('last_cursor'),
  lastSyncAt: text('last_sync_at'),
  itemsSynced: integer('items_synced').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  connectorType: text('connector_type').notNull(),
  accountIdentifier: text('account_identifier'),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  progress: integer('progress').notNull().default(0),
  total: integer('total').notNull().default(0),
  error: text('error'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
});

export const logs = sqliteTable('logs', {
  id: text('id').primaryKey(),
  jobId: text('job_id'),
  connectorType: text('connector_type').notNull(),
  accountId: text('account_id'),
  stage: text('stage'),
  level: text('level').notNull(),
  message: text('message').notNull(),
  timestamp: text('timestamp').notNull(),
});

export const connectorCredentials = sqliteTable('connector_credentials', {
  connectorType: text('connector_type').primaryKey(),
  credentials: text('credentials').notNull(), // encrypted JSON
  updatedAt: text('updated_at').notNull(),
});

export const rawEvents = sqliteTable('raw_events', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  connectorType: text('connector_type').notNull(),
  sourceId: text('source_id').notNull(),
  sourceType: text('source_type').notNull(),
  payload: text('payload').notNull(), // JSON
  timestamp: text('timestamp').notNull(),
  jobId: text('job_id'),
  createdAt: text('created_at').notNull(),
});

// --- Memory tables ---

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  accountId: text('account_id').references(() => accounts.id),
  connectorType: text('connector_type').notNull(),
  sourceType: text('source_type').notNull(), // email | message | photo | location
  sourceId: text('source_id').notNull(),
  text: text('text').notNull(),
  eventTime: text('event_time').notNull(),
  ingestTime: text('ingest_time').notNull(),
  factuality: text('factuality').notNull().default('{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}'),
  weights: text('weights').notNull().default('{"semantic":0,"rerank":0,"recency":0,"importance":0.5,"trust":0.5,"final":0}'),
  entities: text('entities').notNull().default('[]'), // JSON array
  claims: text('claims').notNull().default('[]'), // JSON array
  metadata: text('metadata').notNull().default('{}'), // JSON
  embeddingStatus: text('embedding_status').notNull().default('pending'), // pending | done | failed
  createdAt: text('created_at').notNull(),
});

export const memoryLinks = sqliteTable('memory_links', {
  id: text('id').primaryKey(),
  srcMemoryId: text('src_memory_id').notNull().references(() => memories.id),
  dstMemoryId: text('dst_memory_id').notNull().references(() => memories.id),
  linkType: text('link_type').notNull().default('related'), // related | supports | contradicts
  strength: real('strength').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

// --- Contact tables ---

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  metadata: text('metadata').notNull().default('{}'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const contactIdentifiers = sqliteTable('contact_identifiers', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id),
  identifierType: text('identifier_type').notNull(), // email | phone | slack_id | imessage_handle | name
  identifierValue: text('identifier_value').notNull(),
  connectorType: text('connector_type'),
  confidence: real('confidence').notNull().default(1.0),
  createdAt: text('created_at').notNull(),
});

export const memoryContacts = sqliteTable('memory_contacts', {
  id: text('id').primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id),
  contactId: text('contact_id').notNull().references(() => contacts.id),
  role: text('role').notNull(), // sender | recipient | mentioned | participant
});
