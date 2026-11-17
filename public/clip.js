// Files out of a paste or a drop, for the composer. A screenshot or a browser image arrives with a stock
// name ("image.png") or none, so it gets "pasted-image-<time>.png". Text pastes return no files.
'use strict'
;(function () {
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/tiff': 'tiff', 'image/bmp': 'bmp' }
  const STOCK = /^((image|blob|clipboard|pasted graphic( \d+)?)(\.[a-z0-9]+)?)?$/i // "", "image.png", "Pasted Graphic.tiff"

  const pad = (n) => String(n).padStart(2, '0')
  const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

  /** The name a pasted file is sent under: its own, unless it's the browser's stock name for an image. */
  function nameFor(file, now, i) {
    const name = file.name || ''
    if (!file.type.startsWith('image/') || !STOCK.test(name)) return name || `pasted-file-${stamp(now)}`
    const ext = EXT[file.type] || name.match(/\.([a-z0-9]+)$/i)?.[1] || 'png'
    return `pasted-image-${stamp(now)}${i ? `-${i + 1}` : ''}.${ext}`
  }

  /**
   * The files in a clipboard or drag payload (a DataTransfer), renamed where needed. Empty when it's
   * text. Office apps and Pages put a picture of copied text next to the text (and RTF); that's text.
   */
  function filesFrom(data, now = new Date()) {
    if (!data) return []
    const types = [...(data.types || [])]
    if (types.includes('text/rtf')) return []
    let files = [...(data.files || [])]
    if (!files.length) files = [...(data.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean)
    return files.map((f, i) => {
      const name = nameFor(f, now, i)
      return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified })
    })
  }

  /** Whether a drag carries files (so the chat should light up as a drop target). */
  const dragHasFiles = (data) => [...(data?.types || [])].includes('Files')

  const api = { filesFrom, nameFor, dragHasFiles }
  if (typeof window !== 'undefined') window.clip = api
  if (typeof module !== 'undefined') module.exports = api
})()
