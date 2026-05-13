# Symposium Feedback Viewer

Live read-view for the rare-disease symposium audience-feedback Notion setup.
Notion stays as the data-entry layer (each attendee types in their own
notebook); this app renders a live read-view that **hides the empty slots**
that make the Notion master view unusable at 25 attendees × 18 teams.

## Production

**Live URL:** <https://rarediseasesymposium.ideaflow.app>

- GCP VM: `symposium-viewer` in `us-central1-a` (project `boreal-conquest-464203-v2`)
- Static IP: `35.209.251.123` (reserved as `symposium-viewer-ip`)
- DNS: A record on Vercel DNS (zone `ideaflow.app`, team `ideaflowco`)
- HTTPS: Caddy 2 + Let's Encrypt (auto-renew)
- Process: systemd unit `symposium-viewer.service` runs `node server.mjs` on `127.0.0.1:7412`
- Logs: `sudo journalctl -u symposium-viewer -f` on the VM
- App dir: `/opt/symposium-viewer/`
- Env: `/opt/symposium-viewer/.env`

To redeploy:

```bash
# from your laptop:
tar --exclude=node_modules --exclude=.git -czf /tmp/symposium-viewer.tar.gz .
gcloud compute scp /tmp/symposium-viewer.tar.gz symposium-viewer:/tmp/ --zone us-central1-a
gcloud compute ssh symposium-viewer --zone us-central1-a --command '
  cd /opt/symposium-viewer && tar -xzf /tmp/symposium-viewer.tar.gz && \
  npm install --silent && npm run build && \
  sudo systemctl restart symposium-viewer'
```

## Local dev

```bash
npm install
npm run dev
```

Picks a random free port in 7000–9999 and prints the URL. Mock data is bundled,
so the app works immediately without Notion configured.

## Wire it to real Notion (~2 min)

The pleasant surprise: **you only share ONE page with the integration**, not
all 25 attendee notebooks. Notion's permission model propagates from parent
to children, so the v5 hub share covers everything under it.

1. Create an internal integration at <https://www.notion.so/profile/integrations>.
   Name it "Symposium Viewer". Copy the **Internal Integration Secret**.
2. On the VM:
   ```bash
   gcloud compute ssh symposium-viewer --zone us-central1-a
   sudo nano /opt/symposium-viewer/.env
   # Set NOTION_TOKEN=secret_xxxxxxxx, save
   sudo systemctl restart symposium-viewer
   ```
3. In Notion, open the v5 hub:
   <https://www.notion.so/35ffda9cff6381f8ba77cd69b20e0982>
   Click **... → Connections → add "Symposium Viewer"**.
4. Refresh the live site — header should switch to `live · notion`.

### Adding new attendees

Notion UI: right-click any existing notebook (e.g. "Jacob Cole — notebook") in
the v5 hub's sidebar → **Duplicate** → rename to the new attendee. The
duplicate preserves all 18 synced_block references (the API can't recreate
these from scratch — only the UI Duplicate action does) AND it inherits the
hub's integration access. No further wiring.

For 30+ attendees in one go: still right-click → Duplicate. There's no public
Notion API to script this (`notion-duplicate-page` in Anthropic's MCP wraps a
private endpoint). The good news is the inheritance means once duplicated,
zero per-page setup is needed.

## How it parses notebooks

Each notebook page has `Heading 2` headings of the form

```
Team 3 — Pete's group (Mutation X in gene Y)
```

followed by a synced_block. The server walks the block tree (including
children of synced blocks), buckets blocks by team heading, and converts
the rich-text content to markdown for the UI to render.

## Endpoints

- `GET  /api/feedback`   live state (notion or mock, cached 2.5s)
- `POST /api/feedback`   **mock mode only** — append a reaction (used by the
  in-page "add a reaction" demo to show the live-flash animation)
- `GET  /api/presenting` current team being highlighted
- `POST /api/presenting` `{ "num": 3 }` or `{ "num": null }`
- `GET  /api/health`     `{ ok, mode }`

## Stack

- Local dev: Vite + React 18 + Tailwind 3, Express as middleware on a single
  port (no separate API process to babysit).
- Production: same code, but `server.mjs` serves the built `dist/` statically
  instead of Vite's dev server. Caddy out front for HTTPS termination.
- Polling cadence: client 3s, server-side cache 2.5s → ≤5s end-to-end latency
  from Notion change to browser update.

## Future: tighter latency (post-symposium)

Notion has webhooks now (`page.content_updated`, `block.created`, …). Path:

1. Register a webhook subscription on the integration → Notion POSTs to a new
   `/api/notion-webhook` route whenever a page in scope changes.
2. Signature-verify, invalidate `cachedNotion`, push to SSE-connected
   browsers via an `/api/events` route.
3. Client switches from `setTimeout` polling to `EventSource`.

Drops latency to ~1s, removes the 3s polling chatter. ~1 hour of work,
worth it if this format will be reused for future symposia.
