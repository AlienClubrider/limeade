// Files the user attaches to a message: what's allowed, how they're named on disk, and how the Assistant
// is told about them. Pure rules, no I/O.

/** One uploaded file, as a message records it. The file itself stays on the box. */
export interface Attachment {
  id: string
  name: string
  /** MIME type, from the file's extension (never trusted from the browser). */
  type: string
  size: number
}

/** An attachment with where it lives on the box, for the engine. */
export interface StoredAttachment extends Attachment {
  path: string
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILES_PER_MESSAGE = 5
/** Images above this go by path (the API takes about 5 MB of base64 per image); Claude reads them itself. */
export const MAX_INLINE_IMAGE_BYTES = 3_750_000

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml', html: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  zip: 'application/zip',
}

/** Types Claude takes as image blocks (and Limeade shows as thumbnails). */
const INLINE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** MIME type for a file name; anything unknown is plain bytes. */
export function typeFor(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  return TYPES[ext] ?? 'application/octet-stream'
}

export function isPreviewableImage(type: string): boolean {
  return INLINE_IMAGES.has(type)
}

/** Goes to Claude as an image block (it sees it right away) rather than as a path it reads. */
export function sendsInline(a: Attachment): boolean {
  return INLINE_IMAGES.has(a.type) && a.size <= MAX_INLINE_IMAGE_BYTES
}

/**
 * A file name that is safe on disk and still reads as his: no folders, no leading dots, no control
 * characters, at most 100 characters with the extension kept.
 */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).at(-1) ?? ''
  let name = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  if (!name) name = 'file'
  if (name.length > 100) {
    const ext = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] ?? ''
    name = name.slice(0, 100 - ext.length).trimEnd() + ext
  }
  return name
}

/** Upload ids are ours (random UUIDs); anything else in a path is refused. */
export function isAttachmentId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
}

/** The ids a message names, checked: a list of our ids, no repeats, not too many. */
export function attachmentIds(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every(isAttachmentId)) throw new Error('attachments must be a list of upload ids')
  const ids = [...new Set(v)]
  if (ids.length > MAX_FILES_PER_MESSAGE) throw new Error(`At most ${MAX_FILES_PER_MESSAGE} files per message`)
  return ids
}

/** What a message with only files says in lists and notifications. */
export function attachmentsLabel(list: readonly Attachment[]): string {
  if (!list.length) return ''
  const images = list.filter((a) => a.type.startsWith('image/')).length
  if (images === list.length) return images === 1 ? 'Sent a photo' : `Sent ${images} photos`
  return list.length === 1 ? `Sent ${list[0]!.name}` : `Sent ${list.length} files`
}

/**
 * The lines added to the user's message so the Assistant knows what came with it and where it's saved.
 * Images it can already see are marked so; everything else it opens with its own tools.
 */
/** `inline`: false when photos aren't sent as images (local models), so every file is read by path. */
export function attachmentNote(list: readonly StoredAttachment[], inline = true): string {
  if (!list.length) return ''
  const lines = list.map((a) => {
    const how = inline && sendsInline(a) ? 'shown to you above' : 'open it with the Read tool (or a script for formats Read cannot open)'
    return `- ${a.name} (${a.type}, ${sizeLabel(a.size)}): ${a.path} — ${how}`
  })
  return `[The user attached ${list.length === 1 ? 'a file' : `${list.length} files`}, saved on this computer for later use]\n${lines.join('\n')}`
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
