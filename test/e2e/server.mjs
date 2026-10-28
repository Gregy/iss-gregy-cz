// Static file server for the browser tests. `server.next = true` serves a
// "next version" of the app: bumped APP_VERSION, a marker in index.html, and a
// page element renamed in both index.html and app.js, so a page mixing files
// from the two versions breaks the way real users would see it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.tle': 'text/plain; charset=utf-8',
};

export function startServer() {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    // the TLE the tests are written against, regardless of the deployed copy's age
    const file = path === '/data/iss.tle' ? join(ROOT, 'test/fixtures/iss.tle') : join(ROOT, normalize(path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      let body = await readFile(file);
      if (server.next) {
        let text = body.toString();
        if (path === '/js/config.js') text = text.replace(/APP_VERSION = '([^']+)'/, "APP_VERSION = '$1-next'");
        if (path === '/index.html') text = text.replace('<head>', '<head>\n  <meta name="test-build" content="next">');
        if (path === '/index.html' || path === '/js/app.js') text = text.replaceAll('criteriaPreview', 'criteriaPreviewNext');
        body = Buffer.from(text);
      }
      // generous HTTP caching: updates must get past it
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.2', () => resolve(server)));
}
