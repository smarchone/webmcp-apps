// Static file server for the WebMCP dino game (no backend logic).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3457;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const file = path.normalize(path.join(ROOT, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`WebMCP dino game at http://127.0.0.1:${PORT}`));
