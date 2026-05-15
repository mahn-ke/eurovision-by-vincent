const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number.parseInt(process.env.PORT, 10) || 3001;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

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
    const parsed = new URL(url, 'http://localhost');
    return decodeURIComponent(parsed.pathname);
  } catch {
    return '/';
  }
}

const server = http.createServer((req, res) => {
  const pathname = safePathname(req.url || '/');

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

server.listen(PORT, () => {
  console.log(`Eurovision app running on http://localhost:${PORT}`);
});
