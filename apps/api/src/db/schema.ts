import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id'),  // nullable for migration — will be set for all rows
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
  cleanedText: text('cleaned_text'), // nullable — set by clean processor
  timestamp: text('timestamp').notNull(),
  jobId: text('job_id'),
  createdAt: text('created_at').notNull(),
});

// --- Memory tables ---

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  accountId: text('account_id').references(() => accounts.id),
  memoryBankId: text('memory_bank_id'),  // nullable for migration -- will be set for all rows
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
  pinned: integer('pinned').notNull().default(0),
  recallCount: integer('recall_count').notNull().default(0),
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
  userId: text('user_id'),  // nullable for migration — will be set for all rows
  displayName: text('display_name').notNull(),
  entityType: text('entity_type').notNull().default('person'), // person | organization | location | event | product | topic | pet | group | device | other
  avatars: text('avatars').notNull().default('[]'),
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

export const mergeDismissals = sqliteTable('merge_dismissals', {
  id: text('id').primaryKey(),
  contactId1: text('contact_id_1').notNull().references(() => contacts.id),
  contactId2: text('contact_id_2').notNull().references(() => contacts.id),
  createdAt: text('created_at').notNull(),
});

// --- User authentication tables ---

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  onboarded: integer('onboarded').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const refreshTokens = sqliteTable('refresh_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  family: text('family').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

export const passwordResets = sqliteTable('password_resets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
});

// --- Memory Banks table ---

export const memoryBanks = sqliteTable('memory_banks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  isDefault: integer('is_default').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// --- API Keys table ---

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  lastFour: text('last_four').notNull(),
  memoryBankIds: text('memory_bank_ids'), // nullable JSON array — null = all memory banks
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

// --- Settings table ---

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
