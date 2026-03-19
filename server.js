// server.js
//
// A lightweight static file server implemented using Node's built‑in HTTP module.
// It serves files from the `src/frontend` directory and exposes an optional
// proxy endpoint (`/ollama/chat`) to forward chat requests to a local
// Ollama instance. This avoids pulling in external dependencies like
// Express, which may not be available in all environments.

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';

// Compute __dirname since we're in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = normalize(join(__filename, '..'));

// Directory that holds the frontend assets
const FRONTEND_DIR = join(__dirname, 'src', 'frontend');
//const FRONTEND_DIR = __dirname;

// Basic content type map for common file extensions
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function getMimeType(filePath) {
  return MIME_TYPES[extname(filePath)] || 'application/octet-stream';
}

async function serveStatic(req, res) {
  // Normalize the URL to prevent directory traversal
  let requestedPath = decodeURIComponent(req.url || '/');

  // Strip query parameters
  if (requestedPath.includes('?')) {
    requestedPath = requestedPath.split('?')[0];
  }

  // Default route serves index.html
  if (requestedPath === '/' || requestedPath === '') {
    requestedPath = '/index.html';
  }

  const filePath = join(FRONTEND_DIR, requestedPath);

  // If the path points to a directory, try to serve index.html inside it
  let finalPath = filePath;
  try {
    const stats = statSync(finalPath);
    if (stats.isDirectory()) {
      finalPath = join(finalPath, 'index.html');
    }
  } catch {
    // If statSync throws, we'll handle it below
  }

  // Only serve files that exist under FRONTEND_DIR
  if (!existsSync(finalPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  try {
    const data = await readFile(finalPath);
    const mime = getMimeType(finalPath);
    const headers = { 'Content-Type': mime };
    // For wasm we need correct headers to allow streaming
    if (mime === 'application/wasm') headers['Content-Type'] = 'application/wasm';
    res.writeHead(200, headers);
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

async function handleOllamaProxy(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const r = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const text = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
}

const PORT = process.env.PORT || 3000;

const server = createServer((req, res) => {
  // Proxy endpoint: /ollama/chat (only handle POST requests)
  if (req.url && req.url.startsWith('/ollama/chat') && req.method === 'POST') {
    handleOllamaProxy(req, res);
    return;
  }
  // Otherwise serve static files
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`✅ FormCheck running at http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${FRONTEND_DIR}`);
});