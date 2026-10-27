/**
 * vallBackend.js — Vall Music Backend Engine
 * High-performance music streaming, Spotify scraper integration,
 * Deezer public API aggregator, synced lyrics resolver, and audio proxy.
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const fetch = require('node-fetch');
const SpotifyScraper = require('./spotifyScraper');
const spotifyScraper = new SpotifyScraper();

// Cloud-Optimized YTDL Engine (Heroku / AWS / VPS)
// Bypasses datacenter bot detection & PO-token locks by binding TV & Mweb clients
let ytdlClient = null;
let chooseFormat = null;
try {
  const ytdl = require('@distube/ytdl-core');
  ytdlClient = new ytdl.Ytdl({
    clients: ['tv', 'mweb', 'web_embedded']
  });
  chooseFormat = ytdl.chooseFormat;
} catch (e) {
  console.log('[Vall Music] Ytdl initialized in fallback mode');
}

/**
 * ── 1. Search Music (Deezer API + Spotify metadata bridge) ───────────────────
 */
router.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  if (!query) {
    return res.status(400).json({ status: false, message: 'Query parameter q is required' });
  }

  try {
    const encoded = encodeURIComponent(query);
    const apiUrl = `https://api.deezer.com/search?q=${encoded}&limit=${limit}`;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Deezer search error: ${response.status}`);
    }

    const data = await response.json();
    const tracks = (data.data || []).map((t) => ({
      id: `dz_${t.id}`,
      originalId: t.id,
      source: 'deezer',
      title: t.title_short || t.title,
      artist: t.artist?.name || 'Unknown Artist',
      artistId: t.artist?.id,
      album: t.album?.title || '',
      cover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium,
      coverSmall: t.album?.cover_small,
      duration: t.duration,
      durationFormatted: formatSeconds(t.duration),
      audioUrl: t.preview,
      isExplicit: t.explicit_lyrics || false,
      spotifySearchQuery: `${t.title} ${t.artist?.name || ''}`.trim(),
      deezerLink: t.link
    }));

    res.json({
      status: true,
      query,
      count: tracks.length,
      tracks
    });
  } catch (err) {
    console.error('[Vall Music Search Error]:', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * ── 2. Curated Charts & Playlists ───────────────────────────────────────────
 */
router.get('/charts', async (req, res) => {
  try {
    const category = req.query.category || 'global';
    let query = '';

    if (category === 'global') {
      const response = await fetch('https://api.deezer.com/chart/0/tracks?limit=25');
      const data = await response.json();
      const tracks = mapDeezerTracks(data.data || []);
      
      // Background pre-warming for instant playback on cloud/Heroku
      if (tracks.length > 0) {
        setTimeout(() => {
          resolveFullAudio(tracks[0].title, tracks[0].artist).catch(() => {});
          if (tracks[1]) resolveFullAudio(tracks[1].title, tracks[1].artist).catch(() => {});
          if (tracks[2]) resolveFullAudio(tracks[2].title, tracks[2].artist).catch(() => {});
        }, 50);
      }

      return res.json({ status: true, category: 'Global Top Hits', tracks });
    }

    // Category presets
    const presets = {
      indonesia: 'lagu indonesia viral hits',
      lofi: 'lofi hip hop chill beats study',
      synthwave: 'synthwave retrowave 80s electronic',
      acoustic: 'acoustic guitar chill indie relaxing',
      rnb: 'r&b soul chill vibes',
      rock: 'indie rock alternative modern',
      dance: 'edm electronic party dance hits'
    };

    query = presets[category] || presets['indonesia'];
    const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=25`);
    const data = await response.json();
    const tracks = mapDeezerTracks(data.data || []);

    if (tracks.length > 0) {
      setTimeout(() => {
        resolveFullAudio(tracks[0].title, tracks[0].artist).catch(() => {});
        if (tracks[1]) resolveFullAudio(tracks[1].title, tracks[1].artist).catch(() => {});
      }, 50);
    }

    res.json({
      status: true,
      category,
      tracks
    });
  } catch (err) {
    console.error('[Vall Music Chart Error]:', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * ── 3. Spotify URL Resolver & Downloader (Spotriff Engine) ───────────────────
 */
router.post('/spotify/resolve', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ status: false, message: 'Spotify URL is required' });
  }

  try {
    const result = await spotifyScraper.download(url);
    if (!result.status) {
      // Fallback: If Spotify scraper parsing failed, try searching the song via Deezer
      // Extract track name or fallback search
      const fallback = await fallbackResolve(url);
      if (fallback) {
        return res.json({ status: true, source: 'fallback', data: fallback });
      }
      return res.status(400).json(result);
    }

    res.json({
      status: true,
      source: 'spotify',
      data: {
        id: `sp_${Date.now()}`,
        title: result.data.title,
        artist: result.data.artist,
        duration: result.data.duration,
        cover: result.data.thumbnail,
        audioUrl: result.data.previewUrl || result.data.downloadUrl,
        downloadUrl: result.data.downloadUrl,
        spotifyUrl: result.data.spotifyUrl,
        format: result.data.format
      }
    });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * ── 4. Synced Lyrics Engine (LrcLib API) ──────────────────────────────────────
 */
router.get('/lyrics', async (req, res) => {
  const title = (req.query.title || '').trim();
  const artist = (req.query.artist || '').trim();

  if (!title) {
    return res.status(400).json({ status: false, message: 'Track title is required' });
  }

  try {
    const cleanTitle = title.replace(/\(.*\)|\[.*\]/g, '').trim();
    const cleanArtist = artist.replace(/feat\..*/i, '').trim();
    const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'VallMusicPlayer/1.0 (https://github.com/vall-music)'
      }
    });

    if (!response.ok) {
      // Try search query fallback
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanTitle} ${cleanArtist}`)}`;
      const searchRes = await fetch(searchUrl);
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (searchData && searchData.length > 0) {
          const best = searchData[0];
          return res.json({
            status: true,
            synced: !!best.syncedLyrics,
            syncedLyrics: best.syncedLyrics || null,
            plainLyrics: best.plainLyrics || null,
            parsed: parseLRC(best.syncedLyrics || best.plainLyrics)
          });
        }
      }

      return res.json({
        status: false,
        message: 'Lyrics not found',
        parsed: [
          { time: 0, text: '♪ Instrumental or lyrics unavailable for this track ♪' }
        ]
      });
    }

    const data = await response.json();
    res.json({
      status: true,
      synced: !!data.syncedLyrics,
      syncedLyrics: data.syncedLyrics || null,
      plainLyrics: data.plainLyrics || null,
      parsed: parseLRC(data.syncedLyrics || data.plainLyrics)
    });
  } catch (err) {
    res.json({
      status: false,
      message: err.message,
      parsed: [{ time: 0, text: '♪ Lyrics could not be loaded ♪' }]
    });
  }
});

const streamCache = new Map();

// Innertube helper for fast audio resolution
const INNERTUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const INNERTUBE_URL = 'https://music.youtube.com/youtubei/v1/search';
const INNERTUBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function searchVideoId(query) {
  // Method 1: YTDL Client Search (Fastest, TV client bypasses bot check)
  if (ytdlClient && ytdlClient.search) {
    try {
      const searchResults = await ytdlClient.search(query);
      if (Array.isArray(searchResults) && searchResults.length > 0 && searchResults[0].id) {
        return searchResults[0].id;
      }
    } catch (e) {
      console.warn('[Vall Music] Ytdl search fallback:', e.message);
    }
  }

  // Method 2: YouTube Music Innertube search
  try {
    const searchRes = await fetch(`${INNERTUBE_URL}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': INNERTUBE_UA,
        Origin: 'https://music.youtube.com',
        Referer: 'https://music.youtube.com/'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20231204.01.00',
            hl: 'id',
            gl: 'ID',
            userAgent: INNERTUBE_UA
          }
        },
        query: query
      })
    });

    if (searchRes.ok) {
      const data = await searchRes.json();
      const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const s of tabs) {
        const contents = s?.musicShelfRenderer?.contents || [];
        for (const item of contents) {
          const flex = item?.musicResponsiveListItemRenderer?.flexColumns || [];
          const videoId = flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
                          item?.musicResponsiveListItemRenderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (videoId) return videoId;
        }
      }
    }
  } catch (e) {
    console.warn('[Vall Music] Innertube search fallback:', e.message);
  }

  // Method 3: YouTube HTML search fallback
  try {
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const ytRes = await fetch(ytUrl, {
      headers: { 'User-Agent': INNERTUBE_UA }
    });
    if (ytRes.ok) {
      const html = await ytRes.text();
      const idx = html.indexOf('/watch?v=');
      if (idx !== -1) {
        const videoId = html.substring(idx + 9, idx + 20);
        if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          return videoId;
        }
      }
    }
  } catch (e) {
    console.warn('[Vall Music] HTML search fallback failed:', e.message);
  }

  return null;
}

async function resolveFullAudio(title, artist) {
  const query = `${title} ${artist}`.trim();
  const cacheKey = query.toLowerCase();
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    // Cache for 2 hours
    if (Date.now() - cached.timestamp < 2 * 60 * 60 * 1000) {
      return cached.data;
    }
  }

  const videoId = await searchVideoId(query);

  if (videoId && ytdlClient) {
    try {
      const info = await ytdlClient.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
      
      // CRITICAL FOR MOBILE / IOS SAFARI:
      // Prioritize AAC / MP4 format (audio/mp4, itag 140) which is natively supported on iOS WebKit & Android.
      // WebM / Opus is unsupported by iOS Safari in HTML5 audio tags and causes format errors.
      let format = null;
      try {
        format = chooseFormat(info.formats, {
          filter: f => f.hasAudio && !f.hasVideo && (f.container === 'mp4' || (f.mimeType && f.mimeType.includes('mp4')))
        });
      } catch (e) {}

      if (!format) {
        try {
          format = chooseFormat(info.formats, { filter: f => f.hasAudio && !f.hasVideo });
        } catch (e) {}
      }

      if (format && format.url) {
        const durationSec = parseInt(info.videoDetails.lengthSeconds) || 180;
        const result = {
          videoId,
          title: info.videoDetails.title,
          duration: durationSec,
          durationFormatted: formatSeconds(durationSec),
          streamUrl: `/api/music/proxy-stream?url=${encodeURIComponent(format.url)}`,
          directUrl: format.url,
          mimeType: format.mimeType?.split(';')?.[0] || 'audio/mp4',
          container: format.container || 'mp4',
          info,
          isFullAudio: true
        };
        streamCache.set(cacheKey, { timestamp: Date.now(), data: result, info, videoId });
        return result;
      }
    } catch (e) {
      console.warn('[Vall Music] Ytdl error for ' + videoId + ':', e.message);
    }
  }

  return null;
}

/**
 * ── 4.5 Resolve Full Length Audio Endpoint ──────────────────────────────────
 */
router.get('/resolve-full', async (req, res) => {
  const title = (req.query.title || '').trim();
  const artist = (req.query.artist || '').trim();

  if (!title) {
    return res.status(400).json({ status: false, message: 'Title is required' });
  }

  try {
    const fullAudio = await resolveFullAudio(title, artist);
    if (fullAudio) {
      return res.json({ status: true, data: fullAudio });
    }

    res.json({
      status: false,
      message: 'Full audio stream could not be resolved, fallback to preview'
    });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * ── 4.8 Master Mobile Full Stream Play Endpoint ──────────────────────────────
 * Solves iOS Safari & Android mobile autoplay restrictions by serving
 * the direct stream URL within the initial user gesture, avoiding asynchronous
 * src replacement that triggers NotAllowedError on mobile devices.
 * Uses ytdl.download() stream delivery engine to bypass 403 Forbidden.
 */
router.get('/stream-play', async (req, res) => {
  const title = (req.query.title || '').trim();
  const artist = (req.query.artist || '').trim();
  const preview = (req.query.preview || '').trim();

  if (!title) {
    if (preview) return proxyMediaStream(preview, req, res, 'audio/mpeg');
    return res.status(400).send('Title or preview URL is required');
  }

  try {
    const query = `${title} ${artist}`.trim();
    const cacheKey = query.toLowerCase();

    let info = null;
    let videoId = null;

    if (streamCache.has(cacheKey)) {
      const cached = streamCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 2 * 60 * 60 * 1000) {
        info = cached.info;
        videoId = cached.videoId;
      }
    }

    if (!info) {
      videoId = await searchVideoId(query);
      if (videoId && ytdlClient) {
        info = await ytdlClient.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        streamCache.set(cacheKey, { timestamp: Date.now(), info, videoId });
      }
    }

    if (info && ytdlClient) {
      // iOS & Mobile Compatibility: Prioritize MP4 container (AAC audio)
      let filterOption = f => f.hasAudio && !f.hasVideo && (f.container === 'mp4' || (f.mimeType && f.mimeType.includes('mp4')));
      const hasMp4 = info.formats.some(filterOption);
      if (!hasMp4) {
        filterOption = f => f.hasAudio && !f.hasVideo;
      }

      const downloadOpts = { filter: filterOption };

      // Handle Range Requests (Critical for Mobile Seeking & iOS Safari 2-byte probe)
      if (req.headers.range) {
        const parts = req.headers.range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : undefined;
        downloadOpts.range = { start };
        if (end !== undefined) downloadOpts.range.end = end;

        res.status(206);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'audio/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Cache-Control', 'public, max-age=7200');

        if (end !== undefined) {
          res.setHeader('Content-Range', `bytes ${start}-${end}/*`);
          res.setHeader('Content-Length', (end - start + 1).toString());
        } else {
          res.setHeader('Content-Range', `bytes ${start}-*/*`);
        }
      } else {
        res.status(200);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'audio/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=7200');
      }

      const audioStream = ytdlClient.download(info, downloadOpts);

      audioStream.on('error', (err) => {
        console.error('[Vall Music Stream Error]:', err.message);
        if (!res.headersSent) {
          if (preview) proxyMediaStream(preview, req, res, 'audio/mpeg');
          else res.status(502).send(err.message);
        }
      });

      req.on('close', () => {
        try { audioStream.destroy(); } catch (e) {}
      });

      return audioStream.pipe(res);
    }

    // Fallback to preview only if YouTube resolution completely failed
    if (preview) {
      return proxyMediaStream(preview, req, res, 'audio/mpeg');
    }

    res.status(404).send('Audio stream not available');
  } catch (err) {
    console.error('[Vall Music Master Stream Error]:', err.message);
    if (preview) {
      return proxyMediaStream(preview, req, res, 'audio/mpeg');
    }
    res.status(500).send(err.message);
  }
});

/**
 * ── 5. Audio Stream Proxy (Handles CORS, Redirects, Seeking & Range Requests) ─
 */
function proxyMediaStream(targetUrl, req, res, defaultMime = 'audio/mp4', maxRedirects = 5) {
  if (!targetUrl) {
    return res.status(400).send('Target audio URL is missing');
  }

  const doRequest = (currentUrl, redirectsLeft) => {
    if (redirectsLeft <= 0) {
      return res.status(502).send('Too many redirects from media source');
    }

    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch (e) {
      return res.status(400).send('Invalid media URL');
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': '*/*'
    };
    if (req.headers.range) {
      proxyHeaders['Range'] = req.headers.range;
    }

    const upstreamReq = client.get(currentUrl, { headers: proxyHeaders }, (upstream) => {
      // Follow 3xx HTTP redirects automatically
      if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
        const nextUrl = new URL(upstream.headers.location, currentUrl).toString();
        return doRequest(nextUrl, redirectsLeft - 1);
      }

      res.status(upstream.statusCode);
      ['content-range', 'content-length', 'accept-ranges'].forEach((h) => {
        if (upstream.headers[h]) {
          res.setHeader(h, upstream.headers[h]);
        }
      });
      // Guarantee Range and MIME headers for iOS Safari and Android media playback
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', upstream.headers['content-type'] || defaultMime);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Cache-Control', 'public, max-age=7200');

      upstream.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).send(`Stream fetch error: ${err.message}`);
      }
    });

    req.on('close', () => {
      try {
        upstreamReq.destroy();
      } catch (e) {}
    });
  };

  doRequest(targetUrl, maxRedirects);
}

router.get('/proxy-stream', (req, res) => {
  const audioUrl = req.query.url;
  if (!audioUrl) {
    return res.status(400).send('Missing audio URL');
  }
  proxyMediaStream(audioUrl, req, res, 'audio/mp4');
});

// Helper: Format seconds into mm:ss
function formatSeconds(sec) {
  if (!sec) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// Helper: Map Deezer tracks to uniform Vall Music schema
function mapDeezerTracks(list) {
  return list.map((t) => ({
    id: `dz_${t.id}`,
    originalId: t.id,
    source: 'deezer',
    title: t.title_short || t.title,
    artist: t.artist?.name || 'Unknown Artist',
    artistId: t.artist?.id,
    album: t.album?.title || '',
    cover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium,
    coverSmall: t.album?.cover_small,
    duration: t.duration,
    durationFormatted: formatSeconds(t.duration),
    audioUrl: t.preview,
    isExplicit: t.explicit_lyrics || false,
    spotifySearchQuery: `${t.title} ${t.artist?.name || ''}`.trim()
  }));
}

// Helper: Parse LRC string into timed segments
function parseLRC(lrcText) {
  if (!lrcText) return [];
  const lines = lrcText.split('\n');
  const results = [];
  const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

  for (const line of lines) {
    let match;
    timeRegex.lastIndex = 0;
    while ((match = timeRegex.exec(line)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      const totalSec = min * 60 + sec + ms / 1000;
      const text = line.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();
      if (text) {
        results.push({ time: totalSec, text });
      }
    }
  }

  results.sort((a, b) => a.time - b.time);
  return results;
}

// Helper: Fallback resolver when Spotify scraper is rate-limited
async function fallbackResolve(spotifyUrl) {
  try {
    const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`);
    if (!oembedRes.ok) return null;
    const oembed = await oembedRes.json();
    const trackName = oembed.title || '';

    // Search track in Deezer
    const searchRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(trackName)}&limit=1`);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    if (!searchData.data || searchData.data.length === 0) return null;

    const t = searchData.data[0];
    return {
      id: `sp_fb_${t.id}`,
      title: t.title,
      artist: t.artist?.name || 'Spotify Track',
      duration: formatSeconds(t.duration),
      cover: oembed.thumbnail_url || t.album?.cover_big,
      audioUrl: t.preview,
      downloadUrl: t.preview,
      spotifyUrl: spotifyUrl,
      format: 'mp3'
    };
  } catch (e) {
    return null;
  }
}

module.exports = router;
