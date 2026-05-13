// Mock data used when NOTION_TOKEN is missing or for local UI iteration.
// Also seeded into the in-memory "add a reaction" feature so the live-update
// flash animation can be demoed without Notion configured.

export const TEAMS = [
  { num: 1, descriptor: null },
  { num: 2, descriptor: null },
  { num: 3, descriptor: "Pete's group (Mutation X in gene Y)" },
  { num: 4, descriptor: "Sarah's group (metabolite panel)" },
  { num: 5, descriptor: null },
  { num: 6, descriptor: null },
  { num: 7, descriptor: 'Imaging (MRI region Z anomaly)' },
  { num: 8, descriptor: null },
  { num: 9, descriptor: null },
  { num: 10, descriptor: null },
  { num: 11, descriptor: 'Cellular (fibroblast stimulus response)' },
  { num: 12, descriptor: null },
  { num: 13, descriptor: null },
  { num: 14, descriptor: null },
  { num: 15, descriptor: null },
  { num: 16, descriptor: null },
  { num: 17, descriptor: null },
  { num: 18, descriptor: null },
];

// 25 attendees - 5 named + 20 placeholders, mimicking the symposium scale
const NAMED = ['Jacob Cole', 'Hanan Sinada', 'Pete Kane', 'Pete K.', 'Sarah L.'];
const PLACEHOLDER = Array.from({ length: 20 }, (_, i) => `Attendee ${i + 6}`);
export const ATTENDEES = [...NAMED, ...PLACEHOLDER];

// Notebook page IDs (real ones) so "Open in Notion" works in mock mode too
export const NOTEBOOK_URLS = {
  'Jacob Cole': 'https://www.notion.so/35ffda9cff63811eb82bf770c2258056',
  'Hanan Sinada': 'https://www.notion.so/35ffda9cff63816c8da2df8c413b8cc7',
  'Pete Kane': 'https://www.notion.so/35ffda9cff6381a2b43bf6e6a6fc8f7f',
  'Pete K.': 'https://www.notion.so/35ffda9cff6381fbb7a5de60bab2585f',
  'Sarah L.': 'https://www.notion.so/35ffda9cff6381e3a45fc81e15175d88',
};

// REACTIONS: { teamNum: { attendee: markdownString } }
export const SEED_REACTIONS = {
  3: {
    'Pete K.':
      "N/A — I presented.\n\nIn retrospect: should have led with the family-pedigree slide. Mechanism slide was 1 slide too detailed.",
    'Sarah L.':
      "Strong hypothesis. The pedigree across 4 family members is convincing on segregation.\n\nMy metabolite data is independent confirmation of the same pathway. **This is the convergence point** — figure 1 of the joint paper if we write it.\n\nCaveat: Pete didn't show error bars on the family penetrance plot. Want to see those before saying it's settled.",
  },
  4: {
    'Pete K.':
      "This is **exactly the same pathway** we hit from a different angle. Her metabolite signature maps onto our mutation's predicted disruption — strongest cross-team signal of the day.\n\nMinor concern: n=12 controls is thin. We should pool our cohorts — we have 24 controls she can use.",
    'Sarah L.':
      "N/A — I presented.\n\nFollow-up: should have shown the metabolite-disease severity correlation. It's stronger than I made it look.",
  },
};
