// Headless Playwright backend for recommendations
// Usage: node server.js  -> http://localhost:3000/api/recs?v=<VIDEO_ID>

const express = require('express');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const MAX_ITEMS = 12;
const NAV_TIMEOUT = 20000;
const SELECTOR_TIMEOUT = 10000;

const app = express();

// Allow CORS so the existing frontend can call us
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

let browser; // reuse browser between requests to reduce cold start

app.get('/api/recs', async (req, res) => {
  const videoId = (req.query.v || '').trim();
  if (!videoId) return res.status(400).json({ items: [], error: 'missing_video_id' });
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
    return res.status(400).json({ items: [], error: 'bad_video_id' });
  }

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

    // Try to wait for recommendation cards; ignore timeout if absent
    await page.waitForSelector('ytd-compact-video-renderer', { timeout: SELECTOR_TIMEOUT }).catch(() => {});

    const items = await page.$$eval('ytd-compact-video-renderer', (cards, max) => {
      const out = [];
      const seen = new Set();
      for (const card of cards) {
        if (out.length >= max) break;
        const link = card.querySelector('a#thumbnail');
        const href = link?.getAttribute('href') || '';
        const m = href.match(/v=([\w-]{6,})/);
        const id = m ? m[1] : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const titleEl = card.querySelector('#video-title');
        const title = titleEl?.textContent?.trim() || id;
        const thumb = link?.querySelector('img')?.src || `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
        out.push({ id, title, thumb });
      }
      return out;
    }, MAX_ITEMS);

    await page.close();
    await context.close();

    return res.json({ items });
  } catch (e) {
    console.error('recs error', e);
    return res.status(500).json({ items: [], error: 'scrape_failed' });
  }
});

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Recs backend listening on http://localhost:${PORT}`);
});
