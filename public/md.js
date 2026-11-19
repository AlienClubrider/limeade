// Small Markdown renderer for replies and Toolbox items: paragraphs, headings, lists, quotes, code,
// tables, links, bold/italic. Everything is HTML-escaped first; links must be http(s) or mailto.
'use strict'
;(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  function inline(s) {
    const codes = []
    const chips = []
    s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    s = esc(s)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
      const h = href.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      if (/^(https?:|mailto:)/i.test(h)) return `<a href="${esc(h)}" target="_blank" rel="noopener">${text}</a>`
      // A file the agent made (a diagram, a page): opened through the hub, with its path to copy as well.
      const path = localPath(h)
      // (Paths are held aside until the end, so the bold and italic rules below leave their _ and * alone.)
      const code = (c) => `\u0000${codes.push(c) - 1}\u0000`
      if (path) return `<a href="${esc(fileHref(path))}" target="_blank" rel="noopener">${text}</a> \u0001${chips.push(path) - 1}\u0001`
      // Anything else can't be opened here, so show where it pointed instead of leaving bare text.
      return `${text} ${code(h)}`
    })
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`).replace(/\u0001(\d+)\u0001/g, (_, i) => pathChip(chips[+i]))
  }

  /** "/abs/file", "~/file" or "file:///abs/file" as a path, else null. */
  function localPath(href) {
    let p = href.replace(/^file:\/\/(localhost)?(?=\/)/i, '')
    try { p = decodeURIComponent(p) } catch {}
    return /^(\/|~\/)[^/]/.test(p) && !/[?#]/.test(p) ? p : null
  }

  /**
   * A linked file's short name ("Test.java:72"), with its whole path on hover and copied on a tap (app.js),
   * so a reply full of links doesn't repeat long paths that wrap across lines.
   */
  const pathChip = (path) =>
    `<button type="button" class="pathchip" data-path="${esc(path)}" title="${esc(path)}" aria-label="Copy path ${esc(path)}"><span>${esc(path.replace(/\/+$/, '').split('/').at(-1) || path).replace(/(:\d+(:\d+)?)$/, '<wbr>$1')}</span>${COPY_ICON}</button>`
  const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>'

  /** Where the hub serves a file under home; each part encoded, so the file's own relative links still work. */
  const fileHref = (path) => '/files' + (path.startsWith('~') ? '/' : '') + path.split('/').map((p) => encodeURIComponent(p).replace(/[_*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')

  function render(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
    const out = []
    let i = 0
    const isBlockStart = (l) => /^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+|---+\s*$|\|)/.test(l)
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) { i++; continue }
      if (/^```/.test(l)) {
        const body = []
        i++
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
        i++
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
        continue
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(l)
      if (h) { const n = Math.min(h[1].length, 4); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue }
      if (/^---+\s*$/.test(l) || /^\*\*\*+\s*$/.test(l)) { out.push('<hr>'); i++; continue }
      if (/^>\s?/.test(l)) {
        const body = []
        while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
        out.push(`<blockquote>${render(body.join('\n'))}</blockquote>`)
        continue
      }
      if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-+/.test(lines[i + 1])) {
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
        const head = cells(l)
        i += 2
        const rows = []
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]))
        out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
        continue
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l)
      if (li) {
        const ordered = /\d/.test(li[2])
        const items = []
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
          if (m && /\d/.test(m[2]) === ordered) { items.push(m[3]); i++ }
          else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++ }
          else break
        }
        const tag = ordered ? 'ol' : 'ul'
        out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`)
        continue
      }
      const para = [l]
      i++
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++])
      out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    }
    return out.join('')
  }

  /** Markdown to plain words, for reading aloud and notifications. */
  function plain(src) {
    return String(src ?? '').replace(/```[\s\S]*?```/g, ' (code) ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>|]/g, '')
  }

  const api = { render, plain, esc }
  if (typeof window !== 'undefined') window.md = api
  if (typeof module !== 'undefined') module.exports = api
})()
