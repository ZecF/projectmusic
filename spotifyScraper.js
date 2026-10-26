/**
 * Spotify MP3 Scraper & Downloader Engine for WhatsApp Bots
 * High-reliability edition:
 * - Auto unshortens spotify.link & spoti.fi
 * - Auto normalizes /intl-xx/ & mobile share links
 * - Handles CDN headers (x-run), safe URL encoding & multi-hop redirects
 * - Clean error reporting for WhatsApp group users
 */

const https = require("https");
const http = require("http");

class SpotifyScraper {
  constructor() {
    this.spotriffBase = "https://www.spotriff.com";
    this.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  }

  // ── 1. Unshorten mobile links (spotify.link / spoti.fi) ────────────────────
  async unshortenUrl(url) {
    if (!url.includes("spotify.link") && !url.includes("spoti.fi")) {
      return url;
    }

    return new Promise((resolve) => {
      try {
        const u = new URL(url);
        const lib = u.protocol === "https:" ? https : http;
        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + u.search,
            method: "HEAD",
            headers: {
              "User-Agent": this.userAgent,
            },
          },
          (res) => {
            if (res.headers.location) {
              resolve(res.headers.location);
            } else {
              resolve(url);
            }
          }
        );

        req.on("error", () => resolve(url));
        req.setTimeout(6000, () => {
          req.destroy();
          resolve(url);
        });
        req.end();
      } catch {
        resolve(url);
      }
    });
  }

  // ── 2. Normalize and extract Spotify Track URL ─────────────────────────────
  normalizeTrackUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;

    // Reject non-track types explicitly with clear reasons
    if (rawUrl.includes("/artist/")) {
      throw new Error("Link Artist tidak didukung. Kirimkan link lagu/track!");
    }
    if (rawUrl.includes("/playlist/")) {
      throw new Error("Link Playlist tidak didukung di menu ini. Kirim link per lagu!");
    }
    if (rawUrl.includes("/album/")) {
      throw new Error("Link Album tidak didukung di menu ini. Kirim link per lagu!");
    }
    if (rawUrl.includes("/episode/") || rawUrl.includes("/show/")) {
      throw new Error("Link Podcast tidak didukung!");
    }

    // Match 22-char Spotify Track ID (handles standard, intl-xx, and uri formats)
    const match = rawUrl.match(
      /(?:spotify:track:|spotify\.com\/(?:intl-[a-zA-Z-]+\/)?track\/)([a-zA-Z0-9]{22})/
    );

    if (match && match[1]) {
      return `https://open.spotify.com/track/${match[1]}`;
    }

    return null;
  }

  // ── 3. Internal HTTP Request Helper ────────────────────────────────────────
  _request(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;
      const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;

      const req = client.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: options.method || "GET",
          headers: {
            "User-Agent": this.userAgent,
            ...options.headers,
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: data,
            });
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(options.timeout || 25000, () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── 4. Robust Buffer Downloader (Follows Redirects & Injects Headers) ───────
  async downloadBuffer(url, downloadHeaders = {}, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      const fetchHop = (targetUrl, hopsLeft) => {
        if (hopsLeft <= 0) return reject(new Error("Too many redirects"));

        let parsed;
        try {
          parsed = new URL(targetUrl);
        } catch (err) {
          return reject(new Error(`Invalid download URL: ${err.message}`));
        }

        const client = parsed.protocol === "https:" ? https : http;
        const req = client.get(
          {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: {
              "User-Agent": this.userAgent,
              Referer: "https://www.spotriff.com/",
              ...downloadHeaders,
            },
          },
          (res) => {
            // Follow all 3xx redirects
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
              const nextUrl = new URL(res.headers.location, targetUrl).toString();
              return fetchHop(nextUrl, hopsLeft - 1);
            }

            if (res.statusCode !== 200) {
              return reject(new Error(`Download failed with status ${res.statusCode}`));
            }

            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          }
        );

        req.on("error", reject);
        req.setTimeout(60000, () => {
          req.destroy();
          reject(new Error("Audio download timeout (60s)"));
        });
      };

      fetchHop(url, maxRedirects);
    });
  }

  // ── 5. Main Download Function ──────────────────────────────────────────────
  async download(rawUrl) {
    try {
      if (!rawUrl || typeof rawUrl !== "string") {
        return {
          status: false,
          message: "⚠️ Masukkan link lagu Spotify yang valid!",
        };
      }

      // Step 1: Unshorten if needed
      const unshortened = await this.unshortenUrl(rawUrl.trim());

      // Step 2: Clean and validate track URL
      const cleanUrl = this.normalizeTrackUrl(unshortened);
      if (!cleanUrl) {
        return {
          status: false,
          message:
            "⚠️ Link tidak valid! Pastikan link berupa track Spotify (contoh: https://open.spotify.com/track/...)",
        };
      }

      // Step 3: Call Spotriff API
      const res = await this._request(
        `${this.spotriffBase}/en/download/all/request`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: this.spotriffBase,
            Referer: `${this.spotriffBase}/en`,
          },
        },
        { url: cleanUrl, dt: "" }
      );

      let json;
      try {
        json = JSON.parse(res.body);
      } catch {
        return {
          status: false,
          message: "⚠️ Server converter sedang sibuk, silakan coba beberapa saat lagi.",
        };
      }

      if (!json || json.code !== "success" || !json.data) {
        const errMsg = json?.codeMsg || "Lagu tidak ditemukan.";
        return {
          status: false,
          message: `⚠️ Gagal: ${errMsg}`,
        };
      }

      const data = json.data;
      const audio = data.audios && data.audios.length > 0 ? data.audios[0] : null;

      if (!audio || !audio.url) {
        return {
          status: false,
          message: "⚠️ Audio stream tidak tersedia untuk lagu ini.",
        };
      }

      // Step 4: Decrypt audio URL
      const reversed = audio.url.split("").reverse().join("");
      const downloadUrl = Buffer.from(reversed, "base64").toString("utf-8");
      const downloadHeaders = json.downloadHeaders || {};

      return {
        status: true,
        data: {
          title: data.title || "Unknown Title",
          artist: data.author || "Unknown Artist",
          duration: data.duration || "0:00",
          thumbnail: data.thumbnail || null,
          previewUrl: data.audioPreview || null,
          spotifyUrl: cleanUrl,
          downloadUrl: downloadUrl,
          downloadHeaders: downloadHeaders,
          format: audio.extension || "mp3",
          getBuffer: () => this.downloadBuffer(downloadUrl, downloadHeaders),
        },
      };
    } catch (err) {
      return {
        status: false,
        message: `⚠️ ${err.message}`,
      };
    }
  }
}

module.exports = SpotifyScraper;
