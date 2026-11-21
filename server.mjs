import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicFiles = new Set(['index.html', 'style.css', 'app.js', 'tracking.js', 'vision.js', 'viewer.js']);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
};
const clipFolder = resolve(root, 'video clips');
const isVideo = name => /\.(mp4|webm|mov)$/i.test(name);
const port = Number(process.env.PORT || 4173);

createServer(async (request, response) => {
  try {
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host)) return response.writeHead(403).end();
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405).end();
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
    if (path === 'api/clips') {
      const clips = await readdir(clipFolder, { withFileTypes: true }).catch(() => []);
      const names = clips.filter(clip => clip.isFile() && isVideo(clip.name)).map(clip => clip.name).sort();
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return response.end(request.method === 'HEAD' ? undefined : JSON.stringify(names));
    }
    let file;
    if (!path || publicFiles.has(path)) file = resolve(root, 'src', path || 'index.html');
    if (path.startsWith('clips/')) {
      const name = path.slice(6);
      if (name === basename(name) && isVideo(name)) file = resolve(clipFolder, name);
    }
    if (path === 'models/hand_landmarker.task') file = resolve(root, '.runtime', path);
    if (/^vendor\/(vision_bundle\.mjs|wasm\/vision_wasm_(nosimd_)?internal\.(js|wasm))$/.test(path)) {
      file = resolve(root, 'node_modules', '@mediapipe', 'tasks-vision', path.slice(7));
    }
    if (!file) return response.writeHead(404).end();
    const info = await stat(file);
    if (!info.isFile()) return response.writeHead(404).end();
    const headers = { 'Content-Type': types[extname(file).toLowerCase()], 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = info.size - 1;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match?.[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else if (match?.[2]) {
        start = Math.max(0, info.size - Number(match[2]));
      }
      if (!match || (!match[1] && !match[2]) || start > end) {
        return response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD' || !info.size) return response.end();
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 400);
    response.end();
  }
}).listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`Spinframe is available at ${url}`);
  if (process.argv.includes('--open') && process.platform === 'win32') {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, error => {
      if (error) console.log('Open the address above in Chrome or Edge.');
    });
  }
});
