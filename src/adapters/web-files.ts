// Limeade's files (public/): the page, its script and styles, the service worker, manifest, icons and fonts.
// None of them is private, so they're served before the key check (Access bypasses the manifest, icons
// and service worker, so phones can install the app).

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import type { ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

const ASSET = /^\/(app\.js|md\.js|clip\.js|list-width\.js|live-turn\.js|follow\.js|styles\.css|sw\.js|manifest\.webmanifest|icons\/[a-z0-9-]+\.png|fonts\/[A-Za-z0-9-]+\.(?:woff2|ttf))$/
/** "/app.3f9c1e2ab4.js": a script or stylesheet named by a hash of its content. */
const HASHED = /^\/(app|md|clip|list-width|live-turn|follow|styles)\.[0-9a-f]{10}\.(js|css)$/

export function isWebFile(path: string): boolean {
  return path === '/' || path === '/index.html' || ASSET.test(path) || HASHED.test(path)
}

/** Paths the service worker and manifest may be fetched at without Access (Access bypasses them). */
export function isPublicInstallFile(path: string): boolean {
  return path === '/sw.js' || path === '/manifest.webmanifest' || path.startsWith('/icons/')
}

export async function sendWebFile(res: ServerResponse, dir: string, path: string): Promise<void> {
  if (path === '/' || path === '/index.html') return sendShell(res, dir)
  const hashed = HASHED.exec(path)
  const file = hashed ? `/${hashed[1]}.${hashed[2]}` : path
  const data = await fs.readFile(join(dir, file)).catch(() => null)
  if (!data) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return void res.end('Not found')
  }
  // Fonts and icons never change under the same name; the rest is tagged by content in the page.
  // A hashed name never changes content; fonts never change either.
  const cache = hashed || path.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache })
  res.end(data)
}

/**
 * The page, with each script and stylesheet tagged by a hash of its content. Cloudflare caches .js/.css
 * for hours whatever we say, so a new tag after each change is what makes phones pick up new code.
 */
async function sendShell(res: ServerResponse, dir: string) {
  let html = await fs.readFile(join(dir, 'index.html'), 'utf8')
  for (const name of ['app.js', 'md.js', 'clip.js', 'list-width.js', 'live-turn.js', 'follow.js', 'styles.css', 'sw.js']) {
    const data = await fs.readFile(join(dir, name)).catch(() => null)
    if (!data) continue
    const tag = createHash('sha256').update(data).digest('hex').slice(0, 10)
    const [stem, ext] = name.split('.') as [string, string]
    // The hash goes in the name (no cache keys on query strings that way); sw.js keeps its path, which
    // its scope and the Access bypass depend on. Replaces any hand-bumped ?v=N as well.
    const to = name === 'sw.js' ? `/sw.js?v=${tag}` : `/${stem}.${tag}.${ext}`
    html = html.replace(new RegExp(`"/${stem}\\.${ext}(\\?v=[^"]*)?"`, 'g'), `"${to}"`)
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}
