// Headless Playwright backend for recommendations
// Usage: node server.js  -> http://localhost:3000/api/recs?v=<VIDEO_ID>

const express = require('express');
const { chromium, devices } = require('playwright');

const PORT = process.env.PORT || 3000;
const MAX_ITEMS = 12;
const NAV_TIMEOUT = 20000;
const SELECTOR_TIMEOUT = 12000;

// Mimic a desktop Chrome UA to avoid lightweight pages
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

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
let cachedContext = null; // reuse context for faster requests

// Simple in-memory cache (videoId -> {items, ts})
const recsCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getContext() {
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  if (!cachedContext) {
    cachedContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: UA,
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': ACCEPT_LANGUAGE,
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-CH-UA-Mobile': '?0',
      },
    });
    await cachedContext.addCookies([
      { name: 'CONSENT', value: 'YES+1', domain: '.youtube.com', path: '/', httpOnly: false, secure: true },
      { name: 'PREF', value: 'hl=en&gl=US', domain: '.youtube.com', path: '/', httpOnly: false, secure: true },
    ]);
  }
  return cachedContext;
}

app.get('/api/recs', async (req, res) => {
  const videoId = (req.query.v || '').trim();
  if (!videoId) return res.status(400).json({ items: [], error: 'missing_video_id' });
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
    return res.status(400).json({ items: [], error: 'bad_video_id' });
  }

  // Check cache first
  const cached = recsCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json({ items: cached.items, cached: true });
  }

  try {
    const context = await getContext();
    const page = await context.newPage();

    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en&gl=US`;
    // Use 'domcontentloaded' - much faster, ytInitialData is in initial HTML
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Primary: read from ytInitialData (supports both new lockupViewModel and legacy compactVideoRenderer)
    let items = await page.evaluate((max) => {
      const data = window.ytInitialData;
      const results =
        data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
      const out = [];
      const seen = new Set();
      
      for (const r of results) {
        // New format: lockupViewModel (2024+)
        if (r.lockupViewModel) {
          const lvm = r.lockupViewModel;
          const id = lvm.contentId;
          if (!id || seen.has(id)) continue;
          seen.add(id);

          // Extract title from metadata
          const titleText = lvm.metadata?.lockupMetadataViewModel?.title?.content || id;

          // Extract thumbnail from contentImage (try both structures)
          const thumbVM = lvm.contentImage?.thumbnailViewModel || lvm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel;
          const thumbSources = thumbVM?.image?.sources || [];
          const thumb = (thumbSources[thumbSources.length - 1] || thumbSources[0] || {}).url || `https://img.youtube.com/vi/${id}/hqdefault.jpg`;

          // Extract duration from thumbnailOverlayBadgeViewModel
          let duration = null;
          const overlays = thumbVM?.overlays || [];
          for (const ov of overlays) {
            const badges = ov.thumbnailOverlayBadgeViewModel?.thumbnailBadges || [];
            for (const badge of badges) {
              const txt = badge.thumbnailBadgeViewModel?.text;
              if (txt && /\d+:\d{2}(?::\d{2})?/.test(txt)) {
                duration = txt;
                break;
              }
            }
            if (duration) break;
          }

          out.push({ id, title: titleText, thumb, duration });
          if (out.length >= max) break;
          continue;
        }
        
        // Legacy format: compactVideoRenderer
        const compact = r.compactVideoRenderer || r.compactAutoplayRenderer?.content?.compactVideoRenderer;
        if (!compact) continue;
        const id = compact.videoId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const titleRuns = compact.title?.runs || [];
        const title = titleRuns.map(t => t.text || '').join('') || id;
        const thumbs = compact.thumbnail?.thumbnails || [];
        const thumb = (thumbs[thumbs.length - 1] || thumbs[0] || {}).url || `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
        const duration = compact.lengthText?.simpleText
          || compact.lengthText?.accessibility?.accessibilityData?.label
          || (compact.thumbnailOverlays || [])
            .map(o => o.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || '')
            .find(txt => /\d+:\d{2}(?::\d{2})?/.test(txt))
          || null;
        out.push({ id, title, thumb, duration });
        if (out.length >= max) break;
      }
      return out;
    }, MAX_ITEMS);

    // Fallback: DOM scrape if initial data is empty
    if (!items || items.length === 0) {
      items = await page.$$eval('ytd-rich-item-renderer, ytd-compact-video-renderer', (cards, max) => {
        const out = [];
        const seen = new Set();
        for (const card of cards) {
          if (out.length >= max) break;
          const link = card.querySelector('a#thumbnail, a[href*="watch"]');
          const href = link?.getAttribute('href') || '';
          const m = href.match(/v=([\w-]{6,})/);
          const id = m ? m[1] : '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const titleEl = card.querySelector('#video-title, h3');
          const title = titleEl?.textContent?.trim() || id;
          const thumb = link?.querySelector('img')?.src || `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
          // Try to read duration overlay text if present
          const durEl = card.querySelector('span.ytd-thumbnail-overlay-time-status-renderer');
          const duration = durEl?.textContent?.trim() || null;
          out.push({ id, title, thumb, duration });
        }
        return out;
      }, MAX_ITEMS);
    }

    await page.close();
    // Don't close context - reuse it

    // Cache the result
    recsCache.set(videoId, { items, ts: Date.now() });

    return res.json({ items });
  } catch (e) {
    console.error('recs error', e);
    return res.status(500).json({ items: [], error: 'scrape_failed' });
  }
});

// Debug endpoint - returns ytInitialData structure to diagnose scraping issues
app.get('/api/debug', async (req, res) => {
  const videoId = (req.query.v || 'dQw4w9WgXcQ').trim();
  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    }
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: UA,
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': ACCEPT_LANGUAGE },
    });
    const page = await context.newPage();
    await context.addCookies([
      { name: 'CONSENT', value: 'YES+1', domain: '.youtube.com', path: '/', httpOnly: false, secure: true },
      { name: 'PREF', value: 'hl=en&gl=US', domain: '.youtube.com', path: '/', httpOnly: false, secure: true },
    ]);
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en&gl=US`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(3000);

    // Extract ytInitialData directly from window object
    const debugInfo = await page.evaluate(() => {
      const data = window.ytInitialData;
      if (!data) return { error: 'no ytInitialData in window' };
      
      const twoCol = data?.contents?.twoColumnWatchNextResults;
      const secondary = twoCol?.secondaryResults?.secondaryResults;
      const results = secondary?.results || [];
      
      // Find first lockupViewModel and dump its full structure
      const firstLockup = results.find(r => r.lockupViewModel);
      let lockupDump = null;
      if (firstLockup) {
        const lvm = firstLockup.lockupViewModel;
        lockupDump = {
          contentId: lvm.contentId,
          contentType: lvm.contentType,
          contentImageKeys: Object.keys(lvm.contentImage || {}),
          metadataKeys: Object.keys(lvm.metadata || {}),
          // Dump lockupMetadataViewModel structure
          lockupMetadata: lvm.metadata?.lockupMetadataViewModel ? {
            keys: Object.keys(lvm.metadata.lockupMetadataViewModel),
            title: lvm.metadata.lockupMetadataViewModel.title,
            metadataRows: lvm.metadata.lockupMetadataViewModel.metadataRows,
          } : null,
          // Look for thumbnailOverlays or similar
          rendererContext: lvm.rendererContext ? Object.keys(lvm.rendererContext) : null,
          // Full contentImage structure
          contentImageFull: lvm.contentImage,
        };
      }
      
      return {
        hasContents: !!data?.contents,
        hasTwoColumn: !!twoCol,
        hasSecondary: !!secondary,
        resultsCount: results.length,
        lockupDump,
      };
    });

    await page.close();
    await context.close();

    return res.json({
      videoId,
      url,
      debugInfo,
    });
  } catch (e) {
    console.error('debug error', e);
    return res.status(500).json({ error: e.message });
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
