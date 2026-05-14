// Production server: Express + static dist/, no Vite.
// Used on the deployed VM. Local dev still uses dev.mjs.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { fetchAllReactions, getNotion, getNotebooks, createAttendeeNotebook, purgeBrokenPlaceholders, invalidateCaches } from './src/notion.js';
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

// ---------- SSE + webhook state ----------
const sseClients = new Set();
let webhookSecret = process.env.NOTION_WEBHOOK_SECRET || null;
const WEBHOOK_SECRET_FILE = path.join(__dirname, '.webhook-secret');
try {
  if (!webhookSecret) webhookSecret = (await fs.readFile(WEBHOOK_SECRET_FILE, 'utf-8')).trim() || null;
} catch {}

function broadcastUpdate(reason = 'update') {
  const payload = `event: update\ndata: ${JSON.stringify({ at: Date.now(), reason })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

let invalidateDebounce = null;
function debouncedInvalidate(reason) {
  if (invalidateDebounce) return;
  invalidateDebounce = setTimeout(() => {
    invalidateDebounce = null;
    invalidateCaches();
    broadcastUpdate(reason);
  }, 800);
}

async function main() {
  const app = express();
  // Capture raw body for the webhook route (needed for HMAC verification).
  // All other routes get parsed JSON.
  app.use((req, res, next) => {
    if (req.path === '/api/notion-webhook') return next();
    express.json({ limit: '256kb' })(req, res, next);
  });
  app.use('/api/notion-webhook', express.raw({ type: '*/*', limit: '1mb' }));

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

  // Create a brand-new attendee notebook from scratch.
  // POST { name } -> { name, url, pageId }
  app.post('/api/add-attendee', async (req, res) => {
    if (!getNotion()) return res.status(400).json({ error: 'Live Notion mode required' });
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    if (name.length > 80) return res.status(400).json({ error: 'name too long (max 80 chars)' });
    try {
      // Pass team descriptors from the latest fetched payload (so new notebooks
      // get the same "Team 3 — Pete's group" headings the existing ones have)
      const teamDescriptors = cachedNotion?.teamDescriptors || {};
      const created = await createAttendeeNotebook(name, teamDescriptors);
      console.log(`[add-attendee] created: ${created.name} (${created.pageId})`);
      res.json(created);
    } catch (e) {
      console.error('[add-attendee]', e?.message || e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // One-shot cleanup endpoint for the broken bulk-duplicate placeholders.
  // POST /api/purge-placeholders -> { deleted }
  app.post('/api/purge-placeholders', async (_req, res) => {
    if (!getNotion()) return res.status(400).json({ error: 'Live Notion mode required' });
    try {
      const count = await purgeBrokenPlaceholders();
      invalidateCaches();
      console.log(`[purge] deleted ${count} placeholder notebooks`);
      res.json({ deleted: count });
    } catch (e) {
      console.error('[purge]', e?.message || e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---------- SSE: clients subscribe here, server pushes "update" events
  // whenever Notion content changes (via webhook) ----------
  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (Caddy/nginx)
    });
    res.flushHeaders?.();
    res.write(`event: connected\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    sseClients.add(res);
    // Heartbeat every 20s so proxies don't kill the idle connection
    const hb = setInterval(() => {
      try { res.write(`: hb ${Date.now()}\n\n`); } catch {}
    }, 20000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
  });

  // ---------- Notion webhook receiver ----------
  // Handles two kinds of POSTs from Notion:
  //   1. Verification: body has { verification_token: '...' } — Notion's
  //      handshake. Save the token (becomes our HMAC secret) and echo it.
  //   2. Events: page.content_updated, block.created, etc. Verify HMAC,
  //      invalidate caches, broadcast SSE.
  app.post('/api/notion-webhook', async (req, res) => {
    const rawBody = req.body; // Buffer (from express.raw above)
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return res.status(400).json({ error: 'invalid JSON' });
    }

    // Verification handshake
    if (payload.verification_token) {
      webhookSecret = payload.verification_token;
      try {
        await fs.writeFile(WEBHOOK_SECRET_FILE, webhookSecret + '\n', { mode: 0o600 });
      } catch (e) {
        console.error('[webhook] could not persist secret:', e?.message || e);
      }
      console.log('[webhook] verification handshake complete, secret stored');
      return res.json({ verification_token: payload.verification_token });
    }

    // Signature verification (after we have a secret)
    if (webhookSecret) {
      const sig = req.header('x-notion-signature') || req.header('X-Notion-Signature');
      const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      if (!sig || sig !== expected) {
        console.error('[webhook] signature mismatch (sig=' + sig + ', expected=' + expected + ')');
        return res.status(401).json({ error: 'invalid signature' });
      }
    }

    const eventType = payload.type || payload.event_type || 'unknown';
    console.log(`[webhook] event: ${eventType}`);
    debouncedInvalidate(eventType);
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
