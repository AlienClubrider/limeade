// Small Markdown renderer for replies and Toolbox items: paragraphs, headings, lists, quotes, code,
// tables, links, bold/italic. Everything is HTML-escaped first; links must be http(s) or mailto.
'use strict'
;(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  function inline(s) {
    const codes = []
    s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    s = esc(s)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
      const h = href.replace(/&amp;/g, '&')
      return /^(https?:|mailto:)/i.test(h) ? `<a href="${esc(h)}" target="_blank" rel="noopener">${text}</a>` : text
    })
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`)
  }

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
