// GET /api/recs?v=<VIDEO_ID>
// -> { items: [ { id, title, thumb } ] }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  // Try to pre-consent to skip consent page
  Cookie: 'CONSENT=YES+1; PREF=hl=en',
};

module.exports = async function handler(req, res) {
  const { v } = req.query || {};
  const videoId = (v || '').trim();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!videoId) {
    return res.status(400).json({ items: [], error: 'missing_video_id' });
  }
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
    return res.status(400).json({ items: [], error: 'bad_video_id' });
  }

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(
    videoId
  )}&hl=en`;

  try {
    // First attempt
    let parsed = await fetchAndParse(watchUrl, BASE_HEADERS);

    // If nothing found, try a second attempt with extra params
    if (!parsed.items.length) {
      const altUrl = `${watchUrl}&bpctr=9999999999&has_verified=1&persist_hl=1&persist_gl=1&gl=US`;
      parsed = await fetchAndParse(altUrl, BASE_HEADERS);
    }

    const items = parsed.items;
    return res.status(200).json({ items });
  } catch (e) {
    console.error('recs handler error', e);
    return res.status(500).json({ items: [], error: 'internal_error' });
  }
};

// ---- helpers ----

// Fetch and parse YouTube watch HTML
async function fetchAndParse(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    return { items: [] };
  }
  const html = await resp.text();
  const items = pickFromHtml(html, 12);
  return { items };
}

// Parse YouTube watch HTML and extract sidebar-style recommendations
// by scanning for heading/title + /watch?v=... links.
function pickFromHtml(html, limit = 12) {
  const out = [];
  const seen = new Set();

  // Primary: match h3 with lockup class and title + nested anchor with /watch?v=
  const re = /<h3[^>]*class="[^"]*yt-lockup-metadata-view-model__heading-reset[^"]*"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<a[^>]*href="\/watch\?v=([a-zA-Z0-9_-]{6,})[^"']*"/g;

  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const rawTitle = decodeEntities(m[1] || '');
    const id = m[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: rawTitle || id,
      thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    });
  }

  // Fallback: if nothing matched, grab plain /watch?v= links
  if (!out.length) {
    const hrefRe = /href="\/watch\?v=([a-zA-Z0-9_-]{6,})[^"']*"/g;
    let hm;
    while ((hm = hrefRe.exec(html)) && out.length < limit) {
      const id = hm[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: id,
        thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      });
    }
  }

  return out;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
