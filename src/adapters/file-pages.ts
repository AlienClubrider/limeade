// The pages a linked file opens as when the browser itself goes to it: a text file with numbered lines
// (so "Test.java:72" lands on line 72), and a plain explanation with a way back when it can't be opened.
// No scripts: the line a link points at is the page's #L<n> target.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STYLE = `
:root { color-scheme: dark; --bg: #070B16; --bg2: #0C1326; --text: #EAF0FB; --muted: #93A0C0; --faint: #5D6A8C; --line: rgba(150,170,220,.12); --mark: rgba(77,124,255,.22); --accent: #6F9BFF }
@media (prefers-color-scheme: light) { :root { color-scheme: light; --bg: #F4F6FC; --bg2: #FFFFFF; --text: #101728; --muted: #55617F; --faint: #8B96B0; --line: rgba(34,48,85,.10); --mark: rgba(63,107,245,.16); --accent: #2F5BE0 } }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 400 15px/1.45 system-ui, sans-serif }
header { position: sticky; top: 0; z-index: 1; background: var(--bg2); border-bottom: 1px solid var(--line); padding: calc(env(safe-area-inset-top) + 10px) 14px 10px }
h1 { margin: 0; font-size: 16px; font-weight: 600; overflow-wrap: anywhere }
.path { margin-top: 2px; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; user-select: all }
a { color: var(--accent) }
`

/** A text file as numbered lines, each one an anchor. */
export function sourcePage(path: string, text: string): string {
  const name = path.split('/').at(-1) || path
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  const width = String(lines.length).length
  const rows = lines
    .map((l, i) => `<div class="l" id="L${i + 1}"><a href="#L${i + 1}">${i + 1}</a><span>${esc(l) || ' '}</span></div>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(name)}</title><style>${STYLE}
pre { margin: 0; padding: 8px 0 40vh; font: 13px/1.55 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; tab-size: 4 }
.l { display: flex; scroll-margin-top: 35vh }
.l a { flex: none; box-sizing: content-box; width: ${width}ch; padding: 0 12px 0 10px; text-align: right; color: var(--faint); text-decoration: none; user-select: none }
.l span { flex: 1; min-width: 0; padding-right: 12px; white-space: pre-wrap; overflow-wrap: anywhere }
.l:target { background: var(--mark) }
.l:target a { color: var(--text); font-weight: 600 }
</style></head><body><header><h1>${esc(name)}</h1><div class="path">${esc(path)}</div></header><pre>${rows}</pre></body></html>`
}

/** Why a linked file didn't open, with the way back to the chats instead of a bare error. */
export function fileProblemPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Can't open this file</title><style>${STYLE}
main { max-width: 520px; margin: 0 auto; padding: calc(env(safe-area-inset-top) + 48px) 20px 24px }
h1 { font-size: 20px; margin-bottom: 8px }
p { color: var(--muted); margin: 0 0 20px }
</style></head><body><main><h1>Can't open this file</h1><p>${esc(message)}</p><a href="/">Back to Limeade</a></main></body></html>`
}

/** True for bytes that read as text: valid UTF-8 with no NUL bytes. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}
