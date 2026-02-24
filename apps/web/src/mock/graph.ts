import type { GraphData } from '@botmem/shared';
import { mockMemories } from './memories';
import { truncate } from '@botmem/shared';

const nodes = mockMemories.slice(0, 25).map((m, i) => ({
  id: m.id,
  label: truncate(m.text, 50),
  source: m.source,
  sourceConnector: m.sourceConnector,
  importance: m.weights.importance,
  factuality: m.factuality.label,
  cluster: Math.floor(i / 5),
}));

const linkPairs: Array<[number, number, 'related' | 'supports' | 'contradicts']> = [
  [0, 3, 'related'],     // meeting + flight (Dr. Khalil + travel)
  [0, 9, 'related'],     // meeting + health checkup
  [1, 5, 'related'],     // groceries + dinner plans
  [3, 8, 'related'],     // flight + airport location
  [4, 12, 'supports'],   // deployment + auth bug
  [4, 21, 'related'],    // deployment + db migration
  [5, 10, 'related'],    // dinner at Zuma + dinner at Salt
  [7, 33, 'supports'],   // graph viz + dedup accuracy
  [12, 29, 'supports'],  // auth bug + latency incident
  [13, 7, 'related'],    // whiteboard + graph viz
  [14, 3, 'related'],    // water plants + London flight
  [18, 32, 'related'],   // SIGIR paper + Series A
  [19, 9, 'related'],    // dad's BP + health checkup
  [21, 29, 'supports'],  // db migration + latency fix
  [25, 4, 'related'],    // new hire Layla + deployment
  [22, 3, 'related'],    // passport + flight
  [23, 24, 'related'],   // gym + groceries (routine)
  [6, 11, 'related'],    // CloudFlare bill + AWS bill
  [7, 13, 'supports'],   // graph viz + whiteboard architecture
  [16, 17, 'related'],   // OKR + quarterly
  [10, 5, 'related'],    // Salt dinner + Zuma dinner
  [20, 30, 'related'],   // MacBook + Tesla (purchases)
];

const links = linkPairs
  .filter(([s, t]) => s < nodes.length && t < nodes.length)
  .map(([s, t, linkType]) => ({
    source: nodes[s].id,
    target: nodes[t].id,
    linkType,
    strength: 0.3 + Math.random() * 0.7,
  }));

export const mockGraphData: GraphData = { nodes, links };
