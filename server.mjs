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
let inFlightFetch = null; // dedup concurrent fetches — when SSE pushes to N
                          // clients, only one hits Notion; the rest await
// 2s response cache — short enough to keep visible lag <5s, long enough to
// dedupe concurrent client polls so we don't burst past Notion's 3 req/s limit
const NOTION_TTL_MS = 2000;
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

  // Dedup: if another request is already fetching from Notion, await that one
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = doFreshFetch().finally(() => { inFlightFetch = null; });
  return inFlightFetch;
}

async function doFreshFetch() {
  try {
    const { reactions, teamDescriptors, errors, newestEdit } = await fetchAllReactions();
    cachedNotion = {
      mode: 'notion',
      reactions,
      teamDescriptors,
      errors,
      newestEdit,
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
// Track webhook arrivals for latency observability — ring buffer of recent timestamps + types
const webhookActivity = []; // [{at: ms, type: string}], newest first, max 20
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

// Clears BOTH the low-level Notion caches (in notion.js) AND the server's
// response cache (cachedNotion + lastNotionFetchAt). Without invalidating
// the server response cache, the webhook's freshness gets eaten by our
// own 4s response TTL — clients see stale data for up to 4s after each
// edit even though the webhook arrived in <100ms.
function fullInvalidate() {
  invalidateCaches();         // notebook discovery cache + synced_block cache
  cachedNotion = null;        // server's last-good response
  lastNotionFetchAt = 0;      // server's response TTL check
}

let invalidateDebounce = null;
function debouncedInvalidate(reason) {
  if (invalidateDebounce) return;
  invalidateDebounce = setTimeout(() => {
    invalidateDebounce = null;
    fullInvalidate();
    broadcastUpdate(reason);
  }, 600); // 600ms collapses bursts of edits into one refresh
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
      lastWebhookAt: webhookActivity[0]?.at || null,
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
    const arrivedAt = Date.now();
    // Notion's webhook payload includes a "timestamp" field with the actual
    // event time (sub-second precision). Compare to arrival → network+processing latency.
    const eventTimestamp = payload.timestamp || payload.event_timestamp || payload.created_time || null;
    let latencyMs = null;
    if (eventTimestamp) {
      const eventMs = new Date(eventTimestamp).getTime();
      if (!Number.isNaN(eventMs)) latencyMs = arrivedAt - eventMs;
    }
    // Capture entity info if present (which block/page changed)
    const entity = payload.entity || payload.data?.entity || null;
    const entityId = entity?.id || payload.data?.parent?.id || null;
    webhookActivity.unshift({
      at: arrivedAt,
      type: eventType,
      eventTimestamp,
      latencyMs,
      entityId,
      payloadKeys: Object.keys(payload).slice(0, 20),
    });
    if (webhookActivity.length > 20) webhookActivity.length = 20;
    console.log(`[webhook] event: ${eventType} arrived=${new Date(arrivedAt).toISOString()} eventTs=${eventTimestamp} latency=${latencyMs}ms`);
    debouncedInvalidate(eventType);
    res.json({ ok: true });
  });

  // Webhook activity inspector — last 20 events with arrival times.
  // Use to compute end-to-end latency (edit time → webhook arrival).
  app.get('/api/webhook-activity', (_req, res) => {
    res.json({
      recent: webhookActivity,
      lastWebhookAt: webhookActivity[0]?.at || null,
      lastWebhookType: webhookActivity[0]?.type || null,
      now: Date.now(),
    });
  });

  app.get('/api/presenting', (_req, res) => res.json({ currentlyPresenting }));
  app.post('/api/presenting', (req, res) => {
    const n = req.body?.num;
    currentlyPresenting = n === null || n === undefined ? null : Number(n);
    res.json({ currentlyPresenting });
  });

  // Short URL → notebook-directory view. /notebooks redirects to the SPA
  // with the directory view pre-selected (shareable link, no reactions shown).
  app.get('/notebooks', (_req, res) => res.redirect(302, '/?view=notebooks'));

  // Static files from dist/
  app.use(express.static(DIST, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));

  const port = await pickPort();
  app.listen(port, '127.0.0.1', () => {
    const mode = getNotion() ? 'NOTION (live)' : 'MOCK (no NOTION_TOKEN found)';
    console.log(`[symposium-viewer] listening on 127.0.0.1:${port} — mode: ${mode}`);
  });

  // Background warmer: keep the cache hot 24/7 so the FIRST visitor after a
  // restart doesn't pay the ~18s cold-fetch tax. Refresh slightly faster than
  // server TTL so cachedNotion is always populated when a client hits us.
  if (getNotion()) {
    const WARM_INTERVAL_MS = 5000;
    setInterval(() => {
      getLiveData().catch((e) => console.error('[warmer]', e?.message || e));
    }, WARM_INTERVAL_MS);
    // Fire one immediately at startup so we're hot ASAP
    getLiveData().catch((e) => console.error('[warmer:initial]', e?.message || e));
    console.log('[warmer] background cache refresh every 5s enabled');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
