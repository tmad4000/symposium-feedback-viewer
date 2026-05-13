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

// The page someone actually wants to read in Notion is the master by-talk
// page (where all synced blocks aggregate), NOT the structural hub.
const MASTER_VIEW_URL = 'https://www.notion.so/35ffda9cff6381d39733d791f19daf54';
const HUB_URL = 'https://www.notion.so/35ffda9cff6381f8ba77cd69b20e0982';

const mockReactions = JSON.parse(JSON.stringify(SEED_REACTIONS));
let currentlyPresenting = null;
let lastNotionFetchAt = 0;
let nextNotionFetchAt = 0; // backoff target — don't hit Notion before this
let cachedNotion = null; // last successful payload (keeps showing during transient failures)
let lastError = null;
const NOTION_TTL_MS = 4000;       // normal cache window
const ERROR_BACKOFF_MS = 15_000;  // generic error backoff
const RATE_LIMIT_BACKOFF_MS = 45_000; // longer when Notion explicitly rate-limits

async function getLiveData() {
  if (!getNotion()) {
    return {
      mode: 'mock',
      reactions: mockReactions,
      teamDescriptors: Object.fromEntries(TEAMS.filter((t) => t.descriptor).map((t) => [t.num, t.descriptor])),
      notebookUrls: NOTEBOOK_URLS,
      errors: [],
      hubUrl: HUB_URL,
      masterViewUrl: MASTER_VIEW_URL,
      fetchedAt: Date.now(),
    };
  }

  const now = Date.now();
  const withinCache = now - lastNotionFetchAt < NOTION_TTL_MS && cachedNotion;
  const inBackoff = now < nextNotionFetchAt;
  if (withinCache || inBackoff) {
    if (cachedNotion) {
      // Surface the last error alongside the (possibly stale) data so UI can show it
      return {
        ...cachedNotion,
        errors: lastError ? [lastError, ...(cachedNotion.errors || [])] : (cachedNotion.errors || []),
        stale: inBackoff && !withinCache,
      };
    }
    // No cached data yet — return error envelope without retrying
    return {
      mode: 'notion-error',
      reactions: {},
      teamDescriptors: {},
      notebookUrls: {},
      errors: lastError ? [lastError] : [],
      hubUrl: HUB_URL,
      masterViewUrl: MASTER_VIEW_URL,
      fetchedAt: Date.now(),
    };
  }

  try {
    const { reactions, teamDescriptors, errors } = await fetchAllReactions();
    cachedNotion = {
      mode: 'notion',
      reactions,
      teamDescriptors,
      errors,
      notebookUrls: Object.fromEntries(getNotebooks().map((n) => [n.name, n.url])),
      hubUrl: HUB_URL,
      masterViewUrl: MASTER_VIEW_URL,
      fetchedAt: Date.now(),
    };
    lastNotionFetchAt = Date.now();
    lastError = null;
    nextNotionFetchAt = 0;
    return cachedNotion;
  } catch (e) {
    const msg = String(e?.message || e);
    const isRateLimit = /rate limit/i.test(msg);
    lastError = { notebook: '*', error: msg, at: Date.now() };
    nextNotionFetchAt = Date.now() + (isRateLimit ? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS);
    console.error(`[notion] fetch failed (backoff ${isRateLimit ? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS}ms): ${msg}`);
    // If we have prior data, keep showing it
    if (cachedNotion) {
      return { ...cachedNotion, errors: [lastError, ...(cachedNotion.errors || [])], stale: true };
    }
    return {
      mode: 'notion-error',
      reactions: {},
      teamDescriptors: {},
      notebookUrls: {},
      errors: [lastError],
      hubUrl: HUB_URL,
      masterViewUrl: MASTER_VIEW_URL,
      fetchedAt: Date.now(),
    };
  }
}

async function main() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: getNotion() ? 'notion' : 'mock' });
  });

  app.get('/api/feedback', async (_req, res) => {
    // Prevent any browser/proxy caching — stale data is the worst UX for a live view
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    const data = await getLiveData();
    // Pull the roster (auto-discovered when live, fallback for mock)
    let roster = [];
    if (getNotion()) {
      roster = getNotebooks().map((n) => ({
        name: n.name,
        url: n.url,
        lastEditedTime: n.lastEditedTime || null,
      }));
    } else {
      roster = ATTENDEES.slice(0, 5).map((name) => ({
        name,
        url: data.notebookUrls?.[name] || null,
        lastEditedTime: null,
      }));
    }
    res.json({
      ...data,
      attendees: ATTENDEES,
      roster,
      hubUrl: data.hubUrl || HUB_URL,
      masterViewUrl: data.masterViewUrl || MASTER_VIEW_URL,
      currentlyPresenting,
    });
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
