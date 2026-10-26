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

// Optional YTDL instance for extended streaming
let ytdlClient = null;
let chooseFormat = null;
try {
  const ytdl = require('@distube/ytdl-core');
  ytdlClient = new ytdl.Ytdl();
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

async function resolveFullAudio(title, artist) {
  const query = `${title} ${artist}`.trim();
  const cacheKey = query.toLowerCase();
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    // Cache for 30 minutes
    if (Date.now() - cached.timestamp < 30 * 60 * 1000) {
      return cached.data;
    }
  }

  // Search YouTube Music for videoId
  let videoId = null;
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
        query: query,
        params: 'EgWKAQIIAWoOEAMQBBAJEAoQBRAREBU%3D'
      })
    });

    if (searchRes.ok) {
      const data = await searchRes.json();
      const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const s of tabs) {
        const contents = s?.musicShelfRenderer?.contents || [];
        for (const item of contents) {
          const flex = item?.musicResponsiveListItemRenderer?.flexColumns || [];
          videoId = flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
                    item?.musicResponsiveListItemRenderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (videoId) break;
        }
        if (videoId) break;
      }
    }
  } catch (e) {
    console.warn('[Vall Music] Search fallback:', e.message);
  }

  if (!videoId && ytdlClient) {
    // If not found, try raw title query
    videoId = null;
  }

  if (videoId && ytdlClient) {
    try {
      const info = await ytdlClient.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
      const format = chooseFormat(info.formats, { filter: f => f.hasAudio && !f.hasVideo });
      if (format && format.url) {
        const durationSec = parseInt(info.videoDetails.lengthSeconds) || 180;
        const result = {
          videoId,
          title: info.videoDetails.title,
          duration: durationSec,
          durationFormatted: formatSeconds(durationSec),
          streamUrl: `/api/music/proxy-stream?url=${encodeURIComponent(format.url)}`,
          directUrl: format.url,
          isFullAudio: true
        };
        streamCache.set(cacheKey, { timestamp: Date.now(), data: result });
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
 * ── 5. Audio Stream Proxy (Handles CORS & Partial Content / Seeking) ─────────
 */
router.get('/proxy-stream', async (req, res) => {
  const audioUrl = req.query.url;
  if (!audioUrl) {
    return res.status(400).send('Missing audio URL');
  }

  try {
    const parsed = new URL(audioUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: '*/*'
    };
    if (req.headers.range) {
      proxyHeaders['Range'] = req.headers.range;
    }

    client.get(audioUrl, { headers: proxyHeaders }, (upstream) => {
      // Pass status & content-range headers for seeking
      res.status(upstream.statusCode);
      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
        if (upstream.headers[h]) {
          res.setHeader(h, upstream.headers[h]);
        }
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Cache-Control', 'public, max-age=86400');

      upstream.pipe(res);
    }).on('error', (err) => {
      if (!res.headersSent) res.status(502).send(err.message);
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
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
