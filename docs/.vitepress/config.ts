import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Botmem',
  description: 'Self-hosted personal memory for AI agents',

  appearance: 'dark',
  ignoreDeadLinks: true,
  srcExclude: ['plans/**'],

  head: [
    ['meta', { name: 'theme-color', content: '#F59E0B' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Botmem' }],
    ['meta', { property: 'og:description', content: 'Self-hosted personal memory for AI agents' }],
  ],

  themeConfig: {
    logo: { light: '/logo-light.svg', dark: '/logo-dark.svg' },
    siteTitle: 'Botmem',

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Docs', link: '/guide/' },
      { text: 'API', link: '/api/' },
      { text: 'GitHub', link: 'https://github.com/botmem/botmem' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/guide/' },
          { text: 'Quick Start', link: '/guide/quickstart' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
      {
        text: 'Agent API (MCP)',
        items: [
          { text: 'Overview', link: '/agent-api/' },
          { text: 'MCP Server', link: '/agent-api/mcp-server' },
          { text: 'Tools Reference', link: '/agent-api/tools-reference' },
          { text: 'Examples', link: '/agent-api/examples' },
        ],
      },
      {
        text: 'Connectors',
        items: [
          { text: 'Overview', link: '/connectors/' },
          { text: 'Gmail / Google', link: '/connectors/gmail' },
          { text: 'Slack', link: '/connectors/slack' },
          { text: 'WhatsApp', link: '/connectors/whatsapp' },
          { text: 'iMessage', link: '/connectors/imessage' },
          { text: 'Photos / Immich', link: '/connectors/immich' },
          { text: 'Locations / OwnTracks', link: '/connectors/owntracks' },
          { text: 'Building a Connector', link: '/connectors/building-a-connector' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System Design', link: '/architecture/' },
          { text: 'Ingestion Pipeline', link: '/architecture/pipeline' },
          { text: 'Memory Model', link: '/architecture/memory-model' },
          { text: 'Contacts', link: '/architecture/contacts' },
          { text: 'Memory Graph', link: '/architecture/graph' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Overview', link: '/api/' },
          { text: 'Memories', link: '/api/memories' },
          { text: 'Contacts', link: '/api/contacts' },
          { text: 'Connectors', link: '/api/connectors' },
          { text: 'Jobs', link: '/api/jobs' },
          { text: 'WebSocket', link: '/api/websocket' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Development', link: '/contributing/' },
          { text: 'Connector SDK', link: '/contributing/connector-sdk' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/botmem/botmem' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Your memories. Your agents. Your control.',
      copyright: 'Released under the MIT License.',
    },

    editLink: {
      pattern: 'https://github.com/botmem/botmem/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
