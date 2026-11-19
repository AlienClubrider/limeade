import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isWebFile } from '../src/adapters/web-files.ts'
const fv = createRequire(import.meta.url)('../public/file-view.js')

test('a linked file shows by its type: Markdown rendered, pages previewed, pictures, PDFs, the rest as code', () => {
  assert.equal(fv.kindOf('/a/README.md'), 'markdown')
  assert.equal(fv.kindOf('~/notes/Plan.MARKDOWN'), 'markdown')
  assert.equal(fv.kindOf('/a/diagram.html'), 'html')
  assert.equal(fv.kindOf('/a/page.htm'), 'html')
  for (const f of ['x.png', 'x.JPG', 'x.jpeg', 'x.gif', 'x.webp', 'x.svg']) assert.equal(fv.kindOf(f), 'image', f)
  assert.equal(fv.kindOf('/a/report.pdf'), 'pdf')
  for (const f of ['Test.java', 'a.ts', 'conf.yaml', 'out.log', 'x.diff', 'Makefile', 'archive.zip', 'noext']) assert.equal(fv.kindOf(f), 'text', f)
})

test('code is coloured by its language; logs and unknown files stay plain', () => {
  const cases: [string, string | null][] = [
    ['Test.java', 'java'], ['app.tsx', 'typescript'], ['a.mjs', 'javascript'], ['data.json', 'json'], ['ci.yml', 'yaml'], ['x.py', 'python'],
    ['main.go', 'go'], ['lib.rs', 'rust'], ['run.sh', 'bash'], ['fix.patch', 'diff'], ['a.diff', 'diff'], ['Makefile', 'makefile'],
    ['Dockerfile', 'bash'], ['q.sql', 'sql'], ['page.html', 'xml'], ['README.md', 'markdown'], ['agent-hub.service', 'ini'],
    ['server.log', null], ['notes.txt', null], ['noext', null],
  ]
  for (const [name, lang] of cases) assert.equal(fv.languageOf(name), lang, name)
  // Every language named is one the vendored highlight.js carries.
  const hl = readFileSync(new URL('../public/vendor/highlight.js', import.meta.url), 'utf8')
  for (const [, lang] of cases) if (lang) assert.ok(hl.includes(`grmr_${lang}`), lang)
})

test('a "path:72" link opens the file at line 72, read the way the hub reads it (issue #15)', () => {
  assert.deepEqual(fv.parseRef('/a/Test.java:72'), { path: '/a/Test.java', line: 72, col: null })
  assert.deepEqual(fv.parseRef('~/a/x.ts:72:5'), { path: '~/a/x.ts', line: 72, col: 5 })
  assert.deepEqual(fv.parseRef('/a/Test.java'), { path: '/a/Test.java', line: null, col: null })
  assert.deepEqual(fv.parseRef('/a/x.ts:0'), { path: '/a/x.ts:0', line: null, col: null })
  assert.deepEqual(fv.parseRef('/a/dir/:3'), { path: '/a/dir/:3', line: null, col: null })
  assert.equal(fv.pathOf('/files/~/dev/a%20b.md'), '~/dev/a b.md')
  assert.equal(fv.pathOf('/files/Users/me/Test.java%3A72'), '/Users/me/Test.java:72')
  assert.equal(fv.pathOf('/files/Users/me/Test.java:72#L1'), '/Users/me/Test.java:72')
})

test('coloured code splits into lines that each stand alone, so a line can be numbered and marked', () => {
  const html = 'a <span class="hljs-comment">/* one\ntwo <span class="x">in</span>\nthree */</span> b\n'
  assert.deepEqual(fv.splitLines(html), [
    'a <span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two <span class="x">in</span></span>',
    '<span class="hljs-comment">three */</span> b',
    '',
  ])
  assert.deepEqual(fv.splitLines('x &lt; y\nz'), ['x &lt; y', 'z'])
})

test("a Markdown file's own links and pictures point next to it, through the hub; scripts never", () => {
  const at = '/files/~/dev/app/docs/README.md'
  assert.equal(fv.resolve(at, 'shot.png'), '/files/~/dev/app/docs/shot.png')
  assert.equal(fv.resolve(at, '../src/main.ts#L4'), '/files/~/dev/app/src/main.ts#L4')
  assert.equal(fv.resolve(at, 'my%20file.md'), '/files/~/dev/app/docs/my%20file.md')
  assert.equal(fv.resolve(at, '#install'), '#install')
  assert.equal(fv.resolve(at, 'https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(fv.resolve(at, 'mailto:a@example.com'), 'mailto:a@example.com')
  assert.equal(fv.resolve(at, 'javascript:alert(1)'), null)
  assert.equal(fv.resolve(at, 'data:text/html,hi'), null)
  assert.equal(fv.resolve(at, '//evil.example/x'), null)
  assert.equal(fv.resolve(at, '/etc/passwd'), null) // outside /files/: not something the hub serves
  assert.equal(fv.resolve(at, ''), null)
  assert.equal(fv.slug('Install & run, v2!'), 'install--run-v2')
})

test('text is told from binary the way the hub tells it', () => {
  assert.equal(fv.isText(new TextEncoder().encode('héllo\n')), true)
  assert.equal(fv.isText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1])), false)
  assert.equal(fv.isText(new Uint8Array([0xff, 0xfe, 0x41])), false)
})

/** window.history as far as the viewer uses it: entries, and a Back that fires popstate. */
function fakeHistory(onPop: () => void) {
  const entries: unknown[] = [null]
  return {
    entries,
    get state() { return entries.at(-1) },
    pushState(s: unknown) { entries.push(s) },
    back() { entries.pop(); queueMicrotask(onPop) },
  }
}

test('on a phone, Back closes the viewer and only the viewer; Close steps back over its own entry', async () => {
  let shown = false
  let others = 0 // the app's own popstate handling (pages, sheets) under the viewer
  const pop = () => { if (!nav.popped()) others++ }
  const hist = fakeHistory(pop)
  const nav = fv.viewerNav(hist, () => { shown = false })
  const open = () => { shown = true; nav.opened() }

  // Back (gesture or button) with the viewer open: it closes, the chat under it stays.
  open()
  assert.equal(hist.entries.length, 2)
  hist.back()
  await Promise.resolve()
  assert.equal(shown, false)
  assert.equal(nav.open, false)
  assert.equal(others, 0)

  // Close: hides at once and steps back over the viewer's entry, which nothing else takes for its own Back.
  open()
  nav.close()
  assert.equal(shown, false)
  await Promise.resolve()
  assert.equal(hist.entries.length, 1)
  assert.equal(others, 0)

  // Opening another file from inside the viewer replaces it: still one entry, one Back closes it.
  open(); open()
  assert.equal(hist.entries.length, 2)
  hist.back()
  await Promise.resolve()
  assert.equal(shown, false)

  // With the viewer closed, a Back belongs to whatever is under it.
  hist.pushState({ page: 1 })
  hist.back()
  await Promise.resolve()
  assert.equal(others, 1)
  nav.close() // closing twice is harmless
  assert.equal(hist.entries.length, 1)
})

test('the viewer and its libraries are served from the hub itself, no CDN', () => {
  for (const f of ['/file-view.js', '/file-view.0123456789.js', '/vendor/marked.js', '/vendor/purify.js', '/vendor/highlight.js']) assert.equal(isWebFile(f), true, f)
  assert.equal(isWebFile('/vendor/other.js'), false)
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /https?:\/\/[^'"\s]*(cdn|unpkg|jsdelivr)/)
  for (const f of ['marked', 'purify', 'highlight']) {
    const src = readFileSync(new URL(`../public/vendor/${f}.js`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /sourceMappingURL/, f)
  }
})
