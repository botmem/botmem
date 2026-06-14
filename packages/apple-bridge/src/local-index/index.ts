export { IndexStore, sourceToConnectorType, connectorTypeToSource } from './index-store.js';
export { LocalIndex, defaultIndexPath } from './local-index.js';
export type { LocalIndexOptions } from './local-index.js';
export { imessage } from './sources/imessage.js';
export { whatsapp } from './sources/whatsapp.js';
export { contacts } from './sources/contacts.js';
export type {
  IndexRecord,
  SearchItem,
  SearchFilters,
  SourceAdapter,
  SourceName,
  SourceState,
} from './types.js';
