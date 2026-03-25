export interface TourStep {
  page: string;
  target: string;
  title: string;
  description: string;
  /** Allow user to interact with the highlighted element */
  interactable?: boolean;
  /** Pre-fill search bar with this query (for interactive search steps) */
  searchExample?: string;
}

export const tourSteps: TourStep[] = [
  {
    page: '/dashboard',
    target: '[data-tour="search-bar"]',
    title: 'Search Your Memory',
    description:
      'This is your unified search — query across emails, chats, photos, and locations all at once. Your entire digital history, one search away.',
  },
  {
    page: '/dashboard',
    target: '[data-tour="dashboard-graph"]',
    title: 'Memory Graph',
    description:
      'See connections between your memories visualized in real-time. Nodes are memories, edges are relationships between them.',
  },
  {
    page: '/dashboard',
    target: '[data-tour="search-bar"]',
    title: 'Try a Search',
    description:
      'Click the button below to search your demo data and see results light up in the graph.',
    interactable: true,
    searchExample: 'dinner Zuma Friday',
  },
  {
    page: '/dashboard',
    target: '[data-tour="pipeline-view"]',
    title: 'Pipeline & Logs',
    description:
      'Track sync, embedding, and enrichment progress. Every memory goes through the pipeline: ingest → embed → enrich → searchable.',
  },
  {
    page: '/connectors',
    target: '[data-tour="connectors-grid"]',
    title: 'Connect Your Sources',
    description:
      'Link email, chat, photos, and locations to build your memory. Each connector pulls data from a different service.',
  },
  {
    page: '/people',
    target: '[data-tour="people-grid"]',
    title: 'People & Contacts',
    description:
      'Everyone mentioned across your data, deduplicated and linked. Merge duplicates and explore connections.',
  },
  {
    page: '/me',
    target: '[data-tour="me-identity"]',
    title: 'Your Profile',
    description:
      'Your unified identity — stats, activity, and connected accounts all in one place.',
  },
  {
    page: '/dashboard',
    target: '[data-tour="search-bar"]',
    title: "You're Ready",
    description:
      'Your memory is set up. Connect your real data sources to start building your personal memory, or keep exploring the demo.',
  },
];
