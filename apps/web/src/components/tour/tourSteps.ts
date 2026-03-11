export interface TourStep {
  page: string;
  target: string;
  title: string;
  description: string;
}

export const tourSteps: TourStep[] = [
  {
    page: '/connectors',
    target: '[data-tour="connectors-grid"]',
    title: 'Connect Your Sources',
    description:
      'Link email, chat, photos, and locations to build your memory. Each connector pulls data from a different service.',
  },
  {
    page: '/connectors',
    target: '[data-tour="sync-trigger"]',
    title: 'Sync & Schedule',
    description: 'Trigger manual syncs or set automatic schedules to keep your memory up to date.',
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
    target: '[data-tour="dashboard-graph"]',
    title: 'Memory Graph',
    description:
      'See connections between your memories visualized in real-time. Nodes are memories, edges are relationships.',
  },
  {
    page: '/dashboard',
    target: '[data-tour="pipeline-view"]',
    title: 'Pipeline & Logs',
    description:
      'Track sync, embedding, and enrichment progress. Monitor your data processing pipeline.',
  },
  {
    page: '/people',
    target: '[data-tour="people-grid"]',
    title: 'People & Groups',
    description:
      'Everyone mentioned across your data, deduplicated and linked. Merge duplicates and explore connections.',
  },
  {
    page: '/memories',
    target: '[data-tour="memory-search"]',
    title: 'Search Memories',
    description:
      'Natural language search across all your data sources. Try "meetings last week" or "photos from vacation".',
  },
  {
    page: '',
    target: '',
    title: 'Connect Your Tools',
    description:
      'Set up the MCP server or CLI to access your memories from any AI agent or terminal.',
  },
];
