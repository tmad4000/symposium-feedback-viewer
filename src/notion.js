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

// Pull a flat array of richtext-bearing blocks from a page (including
// children of synced_blocks, which is where the actual content lives).
async function listAllBlocks(client, blockId, depth = 0) {
  if (depth > 4) return [];
  const blocks = [];
  let cursor;
  do {
    const res = await client.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    for (const b of res.results) {
      blocks.push(b);
      // Recurse into synced blocks (and their referenced originals) and toggles to capture nested content
      if (b.type === 'synced_block' || b.has_children) {
        try {
          const children = await listAllBlocks(client, b.id, depth + 1);
          blocks.push(...children.map((c) => ({ ...c, _parentType: b.type })));
        } catch (e) {
          // ignore individual failures
        }
      }
    }
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

// Given the blocks of one notebook, split into per-team buckets.
function bucketByTeam(blocks) {
  const buckets = {}; // teamNum -> { descriptor, lines: [] }
  let current = null;
  for (const b of blocks) {
    if (b.type === 'heading_2') {
      const text = (b.heading_2.rich_text || []).map((r) => r.plain_text).join('');
      const parsed = parseTeamHeading(text);
      if (parsed) {
        current = parsed.num;
        if (!buckets[current]) buckets[current] = { descriptor: parsed.descriptor, lines: [] };
        else if (!buckets[current].descriptor && parsed.descriptor) buckets[current].descriptor = parsed.descriptor;
        continue;
      }
      // unrelated H2 — close current bucket
      current = null;
      continue;
    }
    if (current == null) continue;
    const md = blockToMarkdown(b).trim();
    if (md && !isPlaceholder(md)) buckets[current].lines.push(md);
  }
  // Join lines into markdown blocks
  const out = {};
  for (const [num, { descriptor, lines }] of Object.entries(buckets)) {
    const text = lines.join('\n\n').trim();
    if (text) out[num] = { descriptor, text };
  }
  return out;
}

// Returns { reactions: { teamNum: { attendee: markdown } }, teamDescriptors: { num: str } }
export async function fetchAllReactions() {
  const client = getNotion();
  if (!client) throw new Error('NOTION_TOKEN not set');

  const notebooks = await discoverNotebooks();
  const reactions = {};
  const teamDescriptors = {};
  const errors = [];

  await Promise.all(
    notebooks.map(async (nb) => {
      try {
        const blocks = await listAllBlocks(client, nb.pageId);
        const buckets = bucketByTeam(blocks);
        for (const [num, { descriptor, text }] of Object.entries(buckets)) {
          if (descriptor && !teamDescriptors[num]) teamDescriptors[num] = descriptor;
          if (!reactions[num]) reactions[num] = {};
          reactions[num][nb.name] = text;
        }
      } catch (e) {
        const msg = String(e?.message || e);
        errors.push({ notebook: nb.name, error: msg });
        console.error(`[notion] ${nb.name} (${nb.pageId}): ${msg}`);
      }
    })
  );

  return { reactions, teamDescriptors, errors };
}
