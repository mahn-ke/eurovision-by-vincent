const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number.parseInt(process.env.PORT, 10) || 3001;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function decodeTokenConfig(rawValue) {
  const users = [];
  const usersByToken = new Map();
  const rankingsByUser = new Map();

  if (!rawValue) {
    return { users, usersByToken, rankingsByUser };
  }

  let decoded = '';
  try {
    decoded = Buffer.from(rawValue, 'base64').toString('utf8');
  } catch {
    return { users, usersByToken, rankingsByUser };
  }

  for (const part of decoded.split(',')) {
    const entry = part.trim();
    if (!entry) continue;

    const separator = entry.lastIndexOf(':');
    if (separator <= 0 || separator >= entry.length - 1) continue;

    const username = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (!username || !token || usersByToken.has(token)) continue;

    users.push(username);
    usersByToken.set(token, username);
    rankingsByUser.set(username, []);
  }

  return {
    users,
    usersByToken,
    rankingsByUser,
  };
}

const sharedState = decodeTokenConfig(process.env.tokens || process.env.TOKENS || '');

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(body);
}

function parseUrl(url) {
  return new URL(url || '/', 'http://localhost');
}

function resolveUsername(url) {
  const token = parseUrl(url).searchParams.get('token') || '';
  if (!token) return null;
  return sharedState.usersByToken.get(token) || null;
}

function rankingsPayload() {
  const rankings = {};

  for (const username of sharedState.users) {
    rankings[username] = (sharedState.rankingsByUser.get(username) || []).slice();
  }

  return {
    users: sharedState.users.slice(),
    rankings,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error('Payload too large'));
      }
    });

    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function sanitizeRanking(ranking) {
  if (!Array.isArray(ranking)) return [];
  const unique = new Set();
  const cleaned = [];

  for (const value of ranking) {
    if (typeof value !== 'string' || !value) continue;
    if (unique.has(value)) continue;
    unique.add(value);
    cleaned.push(value);
  }

  return cleaned;
}

function sendFile(res, filePath, noCache = false) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    if (noCache) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
    }

    res.writeHead(200, headers);
    res.end(data);
  });
}

function safePathname(url) {
  try {
    const parsed = parseUrl(url);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return '/';
  }
}

const wsServer = new WebSocket.Server({ noServer: true });

function broadcastRankings(updatedBy) {
  const payload = JSON.stringify({
    type: 'rankings',
    updatedBy,
    ...rankingsPayload(),
  });

  for (const client of wsServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

const server = http.createServer((req, res) => {
  const pathname = safePathname(req.url || '/');

  if (pathname === '/healthz') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end('ok');
    return;
  }

  if (pathname === '/api/auth') {
    const username = resolveUsername(req.url || '/');
    if (!username) {
      json(res, 200, { authenticated: false });
      return;
    }

    json(res, 200, {
      authenticated: true,
      username,
      users: sharedState.users,
    });
    return;
  }

  if (pathname === '/api/rankings') {
    const username = resolveUsername(req.url || '/');
    if (!username) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET') {
      json(res, 200, {
        authenticated: true,
        username,
        ...rankingsPayload(),
      });
      return;
    }

    if (req.method === 'PUT') {
      readJsonBody(req)
        .then((body) => {
          const ranking = sanitizeRanking(body.ranking);
          sharedState.rankingsByUser.set(username, ranking);
          broadcastRankings(username);
          json(res, 200, {
            ok: true,
            username,
            ranking,
          });
        })
        .catch((err) => {
          const statusCode = err.message === 'Payload too large' ? 413 : 400;
          json(res, statusCode, { error: err.message });
        });
      return;
    }

    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET, PUT',
    });
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/') {
    sendFile(res, path.join(ROOT, 'index.html'));
    return;
  }

  if (pathname === '/songs.json') {
    sendFile(res, path.join(ROOT, 'songs.json'), true);
    return;
  }

  const requested = path.normalize(path.join(ROOT, pathname));
  if (!requested.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  sendFile(res, requested);
});

wsServer.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      type: 'rankings',
      ...rankingsPayload(),
    })
  );
});

server.on('upgrade', (req, socket, head) => {
  const parsed = parseUrl(req.url || '/');
  if (parsed.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const username = resolveUsername(req.url || '/');
  if (!username) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(req, socket, head, (ws) => {
    wsServer.emit('connection', ws, req);
  });
});

server.listen(PORT, () => {
  console.log(`Eurovision app running on http://localhost:${PORT}`);
});
