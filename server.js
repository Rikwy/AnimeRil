/* ==========================================================================
   AnimeRil - Advanced Backend Server (Complete Version)
   ========================================================================== */
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const animexScraper = require('./animex');

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

const RATE_LIMIT_WINDOW = 60_000;
const rateLimitStore = new Map();

function rateLimit(ip) {
  const now = Date.now();
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return true;
  }
  const entry = rateLimitStore.get(ip);
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }
  entry.count++;
  return entry.count <= 120;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  return types[ext] || 'application/octet-stream';
}

async function anilistHomeFeed() {
  const gql = `query {
    Page(page: 1, perPage: 50) {
      media(type: ANIME, sort: [TRENDING_DESC, POPULARITY_DESC], isAdult: false) {
        id idMal title { romaji english native } coverImage { extraLarge large color }
        bannerImage format episodes status seasonYear averageScore genres description
      }
    }
  }`;
  const response = await fetch(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: gql }),
  });
  if (response.status !== 200) throw new Error('AniList home fetch failed');
  const json = await response.json();
  return json?.data?.Page?.media || [];
}

async function anilistSearchFull(queryTitle) {
  const gql = `query ($s: String) {
    Page(perPage: 30) {
      media(search: $s, type: ANIME, isAdult: false) {
        id idMal title { romaji english native } coverImage { extraLarge large color }
        bannerImage format episodes status seasonYear averageScore genres description
      }
    }
  }`;
  const response = await fetch(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { s: queryTitle } }),
  });
  if (response.status !== 200) throw new Error('AniList search failed');
  const json = await response.json();
  return json?.data?.Page?.media || [];
}

function formatAnilist(media) {
  const title = media.title?.english || media.title?.romaji || media.title?.native || 'Unknown';
  return {
    id: media.id,
    idMal: media.idMal,
    title,
    image: media.coverImage?.extraLarge || media.coverImage?.large || '',
    banner: media.bannerImage || '',
    format: media.format || 'TV',
    episodes: media.episodes || 0,
    status: media.status || 'RELEASING',
    year: media.seasonYear || '',
    score: media.averageScore || 0,
    genres: media.genres || [],
    description: media.description ? media.description.replace(/<[^>]+>/g, '').substring(0, 300) : ''
  };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  if (!rateLimit(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many requests' }));
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (reqUrl.pathname === '/health' || reqUrl.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', app: 'AnimeRil' }));
    }

    if (reqUrl.pathname === '/api/home/recently-released') {
      const media = await anilistHomeFeed();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ anilist: media.map(formatAnilist) }));
    }

    if (reqUrl.pathname === '/api/anime/search') {
      const q = (reqUrl.searchParams.get('q') || '').trim();
      const media = await anilistSearchFull(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: media.map(formatAnilist) }));
    }

    // API: Animex Servers
    if (reqUrl.pathname === '/api/animex/servers') {
      const anilistId = reqUrl.searchParams.get('anilistId');
      const episode = parseInt(reqUrl.searchParams.get('episode') || '1', 10);
      const data = await animexScraper.animexServers(anilistId, episode);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // API: Animex Stream
    if (reqUrl.pathname === '/api/animex/stream') {
      const anilistId = reqUrl.searchParams.get('anilistId');
      const episode = parseInt(reqUrl.searchParams.get('episode') || '1', 10);
      const type = reqUrl.searchParams.get('type') || 'sub';
      const provider = reqUrl.searchParams.get('providerId') || '';
      
      const data = await animexScraper.animexSources(anilistId, episode, type, provider);
      const src = (data.sources || []).find((s) => /\.m3u8($|\?)/i.test(s.url || ''));
      const m3u8Url = (src && !data.error) ? src.url : null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...data, m3u8Url }));
    }

    // Static files serving (handles index.html, watch.html, etc.)
    let pathname = reqUrl.pathname;
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.join(ROOT, decodeURIComponent(pathname));
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    return res.end(data);

  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1>');
  }
});

server.listen(PORT, () => {
  console.log(`AnimeRil Server running on port ${PORT}`);
});
