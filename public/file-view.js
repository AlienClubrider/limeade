// What the file viewer decides without a page: how a linked file shows (rendered Markdown, an HTML preview,
// highlighted code, a picture, a PDF), which language colours it, a "path:72" line, where a Markdown
// file's own relative links and pictures point, and how the viewer's Close and the phone's Back agree.
'use strict'
;(function () {
  const ext = (name) => (/\.([^./]+)$/.exec(String(name).toLowerCase()) || [])[1] || ''
  const base = (name) => String(name).split('/').at(-1).toLowerCase()

  const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'])

  /** How a file shows: 'markdown', 'html', 'image', 'pdf', else 'text' (shown as code if its bytes are text). */
  function kindOf(name) {
    const e = ext(name)
    if (e === 'md' || e === 'markdown' || e === 'mdx') return 'markdown'
    if (e === 'html' || e === 'htm') return 'html'
    if (IMAGE.has(e)) return 'image'
    if (e === 'pdf') return 'pdf'
    return 'text'
  }

  // highlight.js's common languages, by extension; anything else is plain text (no guessing at logs).
  const LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    json: 'json', jsonc: 'json', webmanifest: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini', env: 'bash',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c',
    cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objectivec', mm: 'objectivec', cs: 'csharp', php: 'php', pl: 'perl', lua: 'lua', r: 'r',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', sql: 'sql', graphql: 'graphql', gql: 'graphql', css: 'css', scss: 'scss', less: 'less',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml', vue: 'xml', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    diff: 'diff', patch: 'diff', mk: 'makefile', vb: 'vbnet', wat: 'wasm', service: 'ini', timer: 'ini', properties: 'ini', gradle: 'kotlin',
  }
  const NAMED = { makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'bash', '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.gitignore': 'bash', '.env': 'bash' }

  /** The highlight.js language for a file, or null for plain text. */
  function languageOf(name) {
    return NAMED[base(name)] || LANG[ext(name)] || null
  }

  /** "dir/Test.java:72" or ":72:5" as the file and its line; a path with no line keeps line null. */
  function parseRef(path) {
    const m = /^(.*?[^/:]):(\d{1,9})(?::(\d{1,9}))?$/.exec(String(path)) // as the hub reads it (places.ts sourceRef)
    return m && +m[2] > 0 ? { path: m[1], line: +m[2], col: m[3] ? +m[3] : null } : { path: String(path), line: null, col: null }
  }

  /**
   * Highlighted HTML (only <span ...> and </span> tags around escaped text) cut into lines that each stand
   * alone: a span open across a line break is closed at its end and opened again on the next line.
   */
  function splitLines(html) {
    const lines = []
    const open = []
    let cur = ''
    for (const [t] of String(html).matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g)) {
      if (t === '\n') {
        lines.push(cur + '</span>'.repeat(open.length))
        cur = open.join('')
      } else {
        if (t.startsWith('<span')) open.push(t)
        else if (t === '</span>') open.pop()
        cur += t
      }
    }
    lines.push(cur + '</span>'.repeat(open.length))
    return lines
  }

  /**
   * Where a Markdown file's own link or picture points: relative ones next to the file (through the hub),
   * web and mail links as they are, a "#heading" as itself; anything else (javascript:, data:) null.
   */
  function resolve(fileUrl, href) {
    const h = String(href ?? '').trim()
    if (!h) return null
    if (h.startsWith('#')) return h
    if (/^(https?:|mailto:)/i.test(h)) return h
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null
    try {
      const u = new URL(h, new URL(fileUrl, 'http://hub'))
      return u.pathname.startsWith('/files/') ? u.pathname + u.search + u.hash : null
    } catch {
      return null
    }
  }

  /** "/files/~/dev/a%20b.md" back to the path it opens: "~/dev/a b.md". */
  function pathOf(fileUrl) {
    const rest = String(fileUrl).replace(/^\/files\//, '').split(/[?#]/)[0]
    let p
    try { p = rest.split('/').map(decodeURIComponent).join('/') } catch { p = rest }
    return p.startsWith('~') ? p : '/' + p
  }

  /** A heading's id for "#heading" links in a Markdown file, the way GitHub makes them. */
  const slug = (text) => String(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')

  /** True for bytes that read as text: valid UTF-8 with no NUL bytes. */
  function isText(bytes) {
    if (bytes.includes(0)) return false
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return true
    } catch {
      return false
    }
  }

  /** Bigger files offer a download instead; past HIGHLIGHT_BYTES code shows uncoloured; past SHOW_LINES, the rest waits for "Show all". */
  const LIMITS = { PREVIEW_BYTES: 5 * 1024 * 1024, HIGHLIGHT_BYTES: 512 * 1024, SHOW_LINES: 5000 }

  /**
   * The viewer and the browser's history agree: opening adds one history entry, so the phone's Back (or a
   * swipe) closes the viewer and nothing under it; Close and Esc step back over that entry themselves.
   * `history` is window.history; `hide` takes the viewer off the screen.
   */
  function viewerNav(history, hide) {
    let open = false
    let ownBack = false
    return {
      get open() { return open },
      opened() {
        if (!open) history.pushState({ viewer: true }, '')
        open = true
      },
      /** Close, Esc, or the scrim: hides now and steps back over our entry. */
      close() {
        if (!open) return
        open = false
        hide()
        if (history.state?.viewer) { ownBack = true; history.back() }
      },
      /** A popstate: true when it was the viewer's (closed it, or our own step back), so nothing else reacts. */
      popped() {
        if (ownBack) { ownBack = false; return true }
        if (!open) return false
        open = false
        hide()
        return true
      },
    }
  }

  const api = { kindOf, languageOf, parseRef, splitLines, resolve, pathOf, slug, isText, LIMITS, viewerNav }
  if (typeof window !== 'undefined') window.fileView = api
  if (typeof module !== 'undefined') module.exports = api
})()
