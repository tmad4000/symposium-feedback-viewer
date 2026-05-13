# Symposium Feedback Viewer

A clean read-view for the rare-disease symposium audience-feedback Notion setup.
Notion stays as the data-entry layer (each attendee types in their own notebook);
this app renders a live read-view that **hides the empty slots** that make the
Notion master view unusable at 25 attendees × 18 teams.

## Run it

```bash
npm install
npm run dev
```

Picks a random free port in 7000–9999 and prints the URL. Mock data is bundled,
so the app works immediately without Notion configured.

## Wire it to real Notion (≤5 min)

1. Create an internal integration at <https://www.notion.so/profile/integrations>.
   Name it "Symposium Viewer".
2. Copy the **Internal Integration Secret** into `.env.local`:
   ```
   NOTION_TOKEN=secret_xxxxxxxxxxxxxxxx
   ```
3. Open each notebook page in Notion → "..." → **Connections** → add **Symposium
   Viewer**. (Notion requires per-page access grants; the v5 hub doesn't
   automatically propagate.)
4. `npm run dev` again — header should show `live · notion`.

## How it parses notebooks

Each notebook page has `Heading 2` headings of the form

```
Team 3 — Pete's group (Mutation X in gene Y)
```

followed by a synced_block. The server walks the block tree (including
children of synced blocks), buckets blocks by team heading, and converts the
rich-text content to markdown for the UI to render.

## Endpoints

- `GET  /api/feedback`   live state (notion or mock, cached 2.5s)
- `POST /api/feedback`   **mock mode only** — append a reaction (used by the
  in-page "add a reaction" demo to show the live-flash animation)
- `GET  /api/presenting` current team being highlighted
- `POST /api/presenting` `{ "num": 3 }` or `{ "num": null }`
- `GET  /api/health`     `{ ok, mode }`

## Stack

Single Node process: Express handling `/api/*`, Vite as middleware for the SPA.
React 18 + Tailwind 3 + react-markdown. No build step needed in dev.
