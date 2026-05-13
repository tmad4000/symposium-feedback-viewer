// Server-side Notion fetcher.
// Reads notebook pages, walks blocks, groups by Team N heading.

import { Client } from '@notionhq/client';

const NOTEBOOKS = [
  { name: 'Jacob Cole',    pageId: '35ffda9cff63811eb82bf770c2258056', url: 'https://www.notion.so/35ffda9cff63811eb82bf770c2258056' },
  { name: 'Hanan Sinada',  pageId: '35ffda9cff63816c8da2df8c413b8cc7', url: 'https://www.notion.so/35ffda9cff63816c8da2df8c413b8cc7' },
  { name: 'Pete Kane',     pageId: '35ffda9cff6381a2b43bf6e6a6fc8f7f', url: 'https://www.notion.so/35ffda9cff6381a2b43bf6e6a6fc8f7f' },
  { name: 'Pete K.',       pageId: '35ffda9cff6381fbb7a5de60bab2585f', url: 'https://www.notion.so/35ffda9cff6381fbb7a5de60bab2585f' },
  { name: 'Sarah L.',      pageId: '35ffda9cff6381e3a45fc81e15175d88', url: 'https://www.notion.so/35ffda9cff6381e3a45fc81e15175d88' },
];

let notion = null;
export function getNotion() {
  if (notion) return notion;
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  notion = new Client({ auth: token });
  return notion;
}

export function getNotebooks() {
  return NOTEBOOKS;
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

  const reactions = {};
  const teamDescriptors = {};
  const errors = [];

  await Promise.all(
    NOTEBOOKS.map(async (nb) => {
      try {
        const blocks = await listAllBlocks(client, nb.pageId);
        const buckets = bucketByTeam(blocks);
        for (const [num, { descriptor, text }] of Object.entries(buckets)) {
          if (descriptor && !teamDescriptors[num]) teamDescriptors[num] = descriptor;
          if (!reactions[num]) reactions[num] = {};
          reactions[num][nb.name] = text;
        }
      } catch (e) {
        errors.push({ notebook: nb.name, error: String(e?.message || e) });
      }
    })
  );

  return { reactions, teamDescriptors, errors };
}
