// Production server: Express + static dist/, no Vite.
// Used on the deployed VM. Local dev still uses dev.mjs.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { fetchAllReactions, getNotion, getNotebooks } from './src/notion.js';
import { SEED_REACTIONS, NOTEBOOK_URLS, TEAMS, ATTENDEES } from './src/mockData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');

function tryListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  const preferred = parseInt(process.env.PORT || '0', 10);
  if (preferred && (await tryListen(preferred))) return preferred;
  let p = 7000 + Math.floor(Math.random() * 3000);
  for (let i = 0; i < 200; i++) {
    if (await tryListen(p)) return p;
    p = 7000 + ((p - 7000 + 1) % 3000);
  }
  return 7412;
}

const mockReactions = JSON.parse(JSON.stringify(SEED_REACTIONS));
let currentlyPresenting = null;
let lastNotionFetchAt = 0;
let cachedNotion = null;
const NOTION_TTL_MS = 2500;

async function getLiveData() {
  if (getNotion()) {
    if (Date.now() - lastNotionFetchAt < NOTION_TTL_MS && cachedNotion) return cachedNotion;
    try {
      const { reactions, teamDescriptors, errors } = await fetchAllReactions();
      cachedNotion = {
        mode: 'notion',
        reactions,
        teamDescriptors,
        errors,
        notebookUrls: Object.fromEntries(getNotebooks().map((n) => [n.name, n.url])),
        fetchedAt: Date.now(),
      };
      lastNotionFetchAt = Date.now();
      return cachedNotion;
    } catch (e) {
      return {
        mode: 'notion-error',
        reactions: {},
        teamDescriptors: {},
        notebookUrls: {},
        errors: [{ notebook: '*', error: String(e?.message || e) }],
        fetchedAt: Date.now(),
      };
    }
  }
  return {
    mode: 'mock',
    reactions: mockReactions,
    teamDescriptors: Object.fromEntries(TEAMS.filter((t) => t.descriptor).map((t) => [t.num, t.descriptor])),
    notebookUrls: NOTEBOOK_URLS,
    errors: [],
    fetchedAt: Date.now(),
  };
}

async function main() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: getNotion() ? 'notion' : 'mock' });
  });

  app.get('/api/feedback', async (_req, res) => {
    const data = await getLiveData();
    res.json({ ...data, attendees: ATTENDEES, currentlyPresenting });
  });

  app.post('/api/feedback', (req, res) => {
    if (getNotion()) return res.status(400).json({ error: 'Disabled in Notion mode — edit your Notion page instead.' });
    const { team, attendee, text } = req.body || {};
    if (!team || !attendee || !text) return res.status(400).json({ error: 'team, attendee, text required' });
    if (!mockReactions[team]) mockReactions[team] = {};
    mockReactions[team][attendee] = text;
    res.json({ ok: true });
  });

  app.get('/api/presenting', (_req, res) => res.json({ currentlyPresenting }));
  app.post('/api/presenting', (req, res) => {
    const n = req.body?.num;
    currentlyPresenting = n === null || n === undefined ? null : Number(n);
    res.json({ currentlyPresenting });
  });

  // Static files from dist/
  app.use(express.static(DIST, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));

  const port = await pickPort();
  app.listen(port, '127.0.0.1', () => {
    const mode = getNotion() ? 'NOTION (live)' : 'MOCK (no NOTION_TOKEN found)';
    console.log(`[symposium-viewer] listening on 127.0.0.1:${port} — mode: ${mode}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
