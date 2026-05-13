// Server-side Notion fetcher.
// Reads notebook pages, walks blocks, groups by Team N heading.
//
// Notebooks are AUTO-DISCOVERED via Notion search rather than hardcoded.
// Filter: pages whose parent is the v5 hub AND title looks like an attendee
// notebook (starts with 📓 or contains "notebook"). New attendees show up
// in the app within ~60s of being created in Notion — no config changes.

import { Client } from '@notionhq/client';

const HUB_PAGE_ID_NO_DASHES = '35ffda9cff6381f8ba77cd69b20e0982';
// Notion API responds with dashed UUIDs in `parent.page_id`; compare normalized.
const HUB_PAGE_ID_NORM = HUB_PAGE_ID_NO_DASHES.replace(/-/g, '').toLowerCase();
const NOTEBOOK_DISCOVERY_TTL_MS = 60_000;

let notion = null;
export function getNotion() {
  if (notion) return notion;
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  notion = new Client({ auth: token });
  return notion;
}

function extractTitle(page) {
  const titleProp = page?.properties?.title || page?.properties?.Name;
  const arr = titleProp?.title || [];
  return arr.map((t) => t.plain_text).join('').trim();
}

// Strip leading emoji + "📓 " and trailing " — notebook" / " - notebook"
function attendeeNameFromTitle(title) {
  let s = title.trim();
  // Strip leading emoji (anything before first letter/space)
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  // Strip "— notebook" suffix with various dashes
  s = s.replace(/\s*[—–\-]\s*notebook\s*$/i, '').trim();
  return s;
}

function looksLikeNotebook(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (t.startsWith('📓')) return true;
  if (/\bnotebook\b/i.test(t)) return true;
  return false;
}

let notebookCache = { at: 0, list: [] };

export async function discoverNotebooks() {
  const client = getNotion();
  if (!client) return [];
  if (Date.now() - notebookCache.at < NOTEBOOK_DISCOVERY_TTL_MS && notebookCache.list.length) {
    return notebookCache.list;
  }

  const results = [];
  let cursor;
  do {
    const res = await client.search({
      filter: { value: 'page', property: 'object' },
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const notebooks = [];
  for (const p of results) {
    if (p.object !== 'page') continue;
    const parentId = (p.parent?.page_id || '').replace(/-/g, '').toLowerCase();
    if (parentId !== HUB_PAGE_ID_NORM) continue;
    const title = extractTitle(p);
    if (!looksLikeNotebook(title)) continue;
    notebooks.push({
      name: attendeeNameFromTitle(title) || title || p.id,
      pageId: p.id,
      url: p.url || `https://www.notion.so/${p.id.replace(/-/g, '')}`,
      lastEditedTime: p.last_edited_time,
    });
  }
  // Stable order: by last_edited_time desc (most active first), tiebreak by name
  notebooks.sort((a, b) => {
    if (a.lastEditedTime && b.lastEditedTime && a.lastEditedTime !== b.lastEditedTime) {
      return b.lastEditedTime.localeCompare(a.lastEditedTime);
    }
    return a.name.localeCompare(b.name);
  });

  notebookCache = { at: Date.now(), list: notebooks };
  console.log(`[notion] discovered ${notebooks.length} attendee notebook(s):`, notebooks.map((n) => n.name).join(', '));
  return notebooks;
}

// Kept for backwards compat with callers that need a list. May return a stale
// cache or empty array if discovery has not been called yet.
export function getNotebooks() {
  return notebookCache.list;
}

// List ONE level of children (no recursion). Used to read the notebook's
// top-level structure (H2 + synced_block placeholders) and to read the
// children of a specific synced_block.
async function listDirectChildren(client, blockId) {
  const blocks = [];
  let cursor;
  do {
    const res = await client.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

function richTextToMarkdown(rt = []) {
  return rt
    .map((t) => {
      let s = t.plain_text || '';
      if (t.annotations?.code) s = '`' + s + '`';
      if (t.annotations?.bold) s = '**' + s + '**';
      if (t.annotations?.italic) s = '*' + s + '*';
      if (t.href) s = `[${s}](${t.href})`;
      return s;
    })
    .join('');
}

function blockToMarkdown(b) {
  const t = b.type;
  const data = b[t];
  if (!data) return '';
  if (t === 'paragraph') return richTextToMarkdown(data.rich_text);
  if (t === 'heading_1') return '# ' + richTextToMarkdown(data.rich_text);
  if (t === 'heading_2') return '## ' + richTextToMarkdown(data.rich_text);
  if (t === 'heading_3') return '### ' + richTextToMarkdown(data.rich_text);
  if (t === 'bulleted_list_item') return '- ' + richTextToMarkdown(data.rich_text);
  if (t === 'numbered_list_item') return '1. ' + richTextToMarkdown(data.rich_text);
  if (t === 'to_do') return `- [${data.checked ? 'x' : ' '}] ` + richTextToMarkdown(data.rich_text);
  if (t === 'quote') return '> ' + richTextToMarkdown(data.rich_text);
  if (t === 'callout') return richTextToMarkdown(data.rich_text);
  if (t === 'code') return '```\n' + richTextToMarkdown(data.rich_text) + '\n```';
  if (data.rich_text) return richTextToMarkdown(data.rich_text);
  return '';
}

// Parse an H2 heading like "Team 3 — Pete's group (Mutation X in gene Y)"
// Returns { num, descriptor } or null.
function parseTeamHeading(text) {
  if (!text) return null;
  // Be liberal on dash characters (— – -) and whitespace
  const m = text.match(/^\s*Team\s+(\d{1,2})\b\s*(?:[—–\-:]+\s*(.+))?\s*$/i);
  if (!m) return null;
  return { num: parseInt(m[1], 10), descriptor: m[2] ? m[2].trim() : null };
}

// Synced-block placeholders to ignore. The v5 template seeds every synced
// block with "(your reactions here)" so attendees know where to type. That
// text is NOT real content — treating it as a reaction defeats the whole
// point of this read-view.
function isPlaceholder(line) {
  if (!line) return true;
  // Strip markdown emphasis + parens + whitespace, lowercase, then compare.
  const stripped = line.replace(/[\*_()`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!stripped) return true;
  if (/^your\s+reactions?\s+here$/.test(stripped)) return true;
  if (/^your\s+notes?\s+here$/.test(stripped)) return true;
  if (/^type\s+your\s+reactions?\s+here$/.test(stripped)) return true;
  if (/^reactions?\s+here$/.test(stripped)) return true;
  return false;
}

// Convert a list of synced_block children to filtered markdown text.
function renderChildrenAsMarkdown(children) {
  const lines = [];
  for (const b of children) {
    const md = blockToMarkdown(b).trim();
    if (md && !isPlaceholder(md)) lines.push(md);
  }
  return lines.join('\n\n').trim();
}

// Returns { reactions: { teamNum: { attendee: markdown } }, teamDescriptors: { num: str } }
// Synced-block content cache keyed on blockId. Stores the rendered markdown
// alongside the synced_block's own last_edited_time. The PAGE's
// last_edited_time does NOT bump when a child synced_block's content
// changes (verified empirically), so caching at page level misses live
// edits. Each synced block has its own last_edited_time that DOES bump.
const syncedBlockCache = new Map(); // blockId -> { lastEditedTime, text }

// Run async tasks with a concurrency cap — prevents bursting past Notion's
// 3 req/s rate limit when many notebooks need refreshing at once.
async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Returns the parsed team-buckets for a single notebook by:
//   1. Listing the page's direct children (1 API call) — gets H2 headings
//      and synced_block stubs (each with its OWN last_edited_time)
//   2. For each synced_block, comparing its last_edited_time to the cache
//   3. Fetching the synced_block's children (1 API call) only if changed
//
// Returns { teamBuckets, hits, misses, latestEdit } where latestEdit is the
// most recent last_edited_time across the page's synced blocks (used by the
// UI for "edited Xs ago" ordering).
async function fetchNotebookBuckets(client, pageId) {
  const topLevel = await listDirectChildren(client, pageId);
  const teamBuckets = {}; // teamNum -> { descriptor, text, lastEditedTime }
  let currentTeam = null;
  let currentDescriptor = null;
  let hits = 0;
  let misses = 0;
  let latestEdit = null;

  for (const b of topLevel) {
    if (b.type === 'heading_2') {
      const text = (b.heading_2?.rich_text || []).map((r) => r.plain_text).join('');
      const parsed = parseTeamHeading(text);
      if (parsed) {
        currentTeam = parsed.num;
        currentDescriptor = parsed.descriptor || null;
      } else {
        currentTeam = null;
        currentDescriptor = null;
      }
      continue;
    }
    if (b.type !== 'synced_block') continue;
    if (currentTeam == null) continue;

    const blockId = b.id;
    const blockEdit = b.last_edited_time;
    if (blockEdit && (!latestEdit || blockEdit > latestEdit)) latestEdit = blockEdit;

    const cached = syncedBlockCache.get(blockId);
    let text;
    if (cached && cached.lastEditedTime === blockEdit) {
      text = cached.text;
      hits++;
    } else {
      const children = await listDirectChildren(client, blockId);
      text = renderChildrenAsMarkdown(children);
      syncedBlockCache.set(blockId, { lastEditedTime: blockEdit, text });
      misses++;
    }
    if (text) {
      teamBuckets[currentTeam] = { descriptor: currentDescriptor, text, lastEditedTime: blockEdit };
    }
  }
  return { teamBuckets, hits, misses, latestEdit };
}

export async function fetchAllReactions() {
  const client = getNotion();
  if (!client) throw new Error('NOTION_TOKEN not set');

  const notebooks = await discoverNotebooks();
  const reactions = {};                // teamNum -> { attendeeName: text }
  const reactionEdits = {};            // teamNum -> { attendeeName: lastEditedTime }
  const teamDescriptors = {};
  const errors = [];
  let totalHits = 0;
  let totalMisses = 0;

  await withConcurrency(notebooks, 2, async (nb) => {
    try {
      const { teamBuckets, hits, misses } = await fetchNotebookBuckets(client, nb.pageId);
      totalHits += hits;
      totalMisses += misses;
      for (const [num, { descriptor, text, lastEditedTime }] of Object.entries(teamBuckets)) {
        if (descriptor && !teamDescriptors[num]) teamDescriptors[num] = descriptor;
        if (!reactions[num]) reactions[num] = {};
        if (!reactionEdits[num]) reactionEdits[num] = {};
        reactions[num][nb.name] = text;
        reactionEdits[num][nb.name] = lastEditedTime;
      }
    } catch (e) {
      const msg = String(e?.message || e);
      errors.push({ notebook: nb.name, error: msg });
      console.error(`[notion] ${nb.name} (${nb.pageId}): ${msg}`);
    }
  });

  // Sort each team's reactions by lastEditedTime descending (most recent first)
  const orderedReactions = {};
  for (const [num, byA] of Object.entries(reactions)) {
    const sorted = Object.entries(byA).sort((a, b) => {
      const ta = reactionEdits[num]?.[a[0]] || '';
      const tb = reactionEdits[num]?.[b[0]] || '';
      if (ta !== tb) return tb.localeCompare(ta);
      return a[0].localeCompare(b[0]);
    });
    orderedReactions[num] = Object.fromEntries(sorted);
  }

  if (totalMisses > 0 || totalHits === 0) {
    console.log(`[notion] checked ${notebooks.length} notebook(s): ${totalHits} synced-blocks cached, ${totalMisses} refetched`);
  }
  return { reactions: orderedReactions, reactionEdits, teamDescriptors, errors };
}
