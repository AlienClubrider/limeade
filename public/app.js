// Limeade: the user's assistant, its workers and their MCP servers, skills and agents, in the browser. Talks to the hub it's served from
// (on this computer, or behind Cloudflare Access on a server). Claude-app quiet: one muted line per turn, no pills, no diffs.
'use strict'

// ---------- tiny DOM helpers ----------

const $ = (sel, root = document) => root.querySelector(sel)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'html') el.innerHTML = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'style') el.setAttribute('style', v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid))
  return el
}
/** Replace an element's children; lists are flattened and empty slots (null/false) skipped. */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false))
}
const svg = (path, extra = '') => h('span', { html: `<svg viewBox="0 0 24 24" ${extra}>${path}</svg>`, style: 'display:inline-flex' })
const ICON = {
  chevR: '<path d="M9 6l6 6-6 6"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  speak: '<path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
}

const toastEl = $('#toast')
let toastTimer
function toast(text) {
  toastEl.textContent = text
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600)
}

// ---------- hub API ----------

class HubError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

async function api(method, path, body) {
  let r
  try {
    r = await fetch(path, {
      method,
      credentials: 'same-origin',
      redirect: 'manual', // Access answers an expired session with a redirect to its sign-in page
      headers: body instanceof Blob ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new HubError(0, "Can't reach the hub")
  }
  // Access sends its sign-in page (or a redirect) when the session ran out.
  const json = (r.headers.get('content-type') || '').includes('json')
  if (r.type === 'opaqueredirect' || r.status === 401 || (r.status === 403 && !json)) {
    signedOut()
    throw new HubError(401, 'Signed out')
  }
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new HubError(r.status, (j && (j.error?.message || j.error)) || `The hub said ${r.status}`)
  return j
}
let signedOutShown = false
function signedOut() {
  if (signedOutShown) return
  signedOutShown = true
  dialog({ title: 'Signed out', text: 'Your Cloudflare sign-in ran out. Sign in again to carry on.', ok: 'Sign in', onOk: () => location.reload() })
}

// ---------- state ----------

const S = {
  tab: 'assistant',
  /** Wide windows: which list row the side panel shows ("w:<id>" or "<kind>:<id>"), for its highlight. */
  panelFor: null,
  connected: false,
  /** The bell: things waiting on the user. */
  inbox: [],
  models: [],
  assistant: null, // the Assistant's conversation (see convo())
  /** The Chat page: the user's chats (summaries, newest first) and the one open now. */
  chats: null,
  chatsError: null,
  openChat: null,
  /** Machines and recent folders for the "where" chip. */
  places: null,
  /** The hub's own settings: this computer's name, whether it's only on this computer, the Ollama address. */
  hub: null,
  seenAt: Number(localStorage.getItem('assistantSeen') || Date.now()),
  workers: null,
  workersError: null,
  tools: null,
  toolsError: null,
  toolKind: 'skill', // which of the MCP, Skills and Agents pages is showing
  toolQuery: { mcp: '', skill: '', agent: '' }, // each page keeps its own search
}

const MODES = [
  ['ask', 'Ask before running', 'Asks before each command or file change.', 'Ask'],
  ['acceptEdits', 'Auto-accept edits', 'Changes files without asking. Asks before commands.', 'Edits'],
  ['auto', 'Auto', 'Runs without asking. Safety checks still stop risky commands.', 'Auto'],
  ['plan', 'Plan only', 'Reads and makes a plan. Changes nothing.', 'Plan'],
]
const KIND = { skill: ['Skill', 'Skills'], agent: ['Agent', 'Agents'], mcp: ['MCP server', 'MCP'] }

function modelLabel(id) {
  for (const g of S.models) for (const m of g.models) if (m.id === id) return m.label
  if (modelRemoved(id)) return 'Model removed'
  const name = id.slice(id.indexOf(':') + 1)
  return id.startsWith('claude:') ? name[0].toUpperCase() + name.slice(1) : name
}
/** A model the list no longer has (he removed it): the chat needs a new pick before it can send. */
function modelRemoved(id) {
  return S.models.length > 0 && !S.models.some((g) => g.models.some((m) => m.id === id))
}

/** The phone chip's name: no size or machine ("Qwen 3.8 27B · Mac" -> "Qwen 3.8"); the sheet keeps the full one. */
function shortModelLabel(label) {
  return label.replace(/ · .*$/, '').replace(/ \d+(?:\.\d+)?[BMK]$/, '') || label
}

/** Text that differs by width: the full one on a computer, a shorter one on a phone. */
const byWidth = (wide, narrow) => wide === narrow ? wide : [h('span', { class: 'wide-only' }, wide), h('span', { class: 'narrow-only' }, narrow)]
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '')

/** A local model that can't call tools: it only chats (no files, commands or folder). */
function isChatOnly(id) {
  for (const g of S.models) for (const m of g.models) if (m.id === id) return !!m.chatOnly
  return false
}

function timeLabel(at) {
  const d = new Date(at)
  const now = new Date()
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((today - day) / 86400000)
  if (diff === 0) return clock
  if (diff === 1) return `Yesterday ${clock}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock}`
}
function ago(at) {
  const s = (Date.now() - new Date(at).getTime()) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** "Running" / "Ran 2 commands, edited 1 file": one muted line per turn. */
function statusLabel(steps, running) {
  if (running) return 'Running'
  const count = (names) => steps.filter((s) => names.includes(s.tool)).length
  const commands = count(['Bash'])
  const edits = count(['Edit', 'Write', 'NotebookEdit'])
  const reads = count(['Read', 'Grep', 'Glob'])
  const other = steps.length - commands - edits - reads
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`
  const parts = [
    commands && `ran ${n(commands, 'command', 'commands')}`,
    edits && `edited ${n(edits, 'file', 'files')}`,
    reads && `read ${n(reads, 'file', 'files')}`,
    other && `used ${n(other, 'tool', 'tools')}`,
  ].filter(Boolean)
  return cap(parts.join(', '))
}

// ---------- live updates ----------

let es = null
function connect() {
  if (es) es.close()
  es = new EventSource('/stream')
  es.addEventListener('hello', (e) => {
    S.connected = true
    paintConn()
    try { S.chatBusy = Object.fromEntries((JSON.parse(e.data).busy || []).map((id) => [id, true])) } catch {}
    loadAssistant() // catch up on anything missed while away
    // Back after a drop (often a hub restart): newer code, or a model's tool support or name may have changed.
    if (connect.seen) { reloadIfUpdated(); loadModels() }
    connect.seen = true
    openChatView()?.load()
    if (S.chats) loadChats()
    loadWorkers()
  })
  es.onerror = () => {
    S.connected = false
    paintConn()
    // EventSource retries on its own; if it gave up (e.g. Access signed out), try again later.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000)
  }
  for (const name of ['message', 'delta', 'live', 'step', 'busy', 'approval', 'approval_done', 'notice', 'workers', 'fleet_mode', 'inbox', 'chat', 'pull', 'local_models', 'agents']) {
    es.addEventListener(name, (e) => {
      let data = {}
      try { data = JSON.parse(e.data) } catch {}
      onEvent(name, data)
    })
  }
}

function onEvent(name, d) {
  if (name === 'pull' || name === 'local_models') return onLocalEvent(name, d)
  if (name === 'agents') return onAgentsEvent()
  if (name === 'notice' || name === 'workers') { loadWorkers(); return }
  if (name === 'inbox') { setInbox(d.items || []); return }
  if (name === 'chat') return chatChanged(d)
  if (name === 'approval_done') {
    for (const V of [S.assistant, S.openChat]) if (V) { V.approvals = V.approvals.filter((a) => a.id !== d.id); paintConvo(V) }
    return
  }
  // Streamed text and steps only touch the live reply, a frame at a time, so typing never waits on them.
  const streamed = name === 'delta' || name === 'step' || name === 'live'
  if (applyEvent(S.assistant, name, d)) return streamed ? liveSoon(S.assistant) : paintThread()
  if (applyEvent(S.openChat, name, d)) streamed ? liveSoon(S.openChat) : paintConvo(S.openChat)
  // A chat's newest line and busy dot in the list.
  if (d.chatId !== 'assistant' && (name === 'message' || name === 'busy')) chatListActivity(d.chatId, name === 'busy' ? !!d.busy : null)
}

/** Friendly model names and tool support arrive with the list: repaint what shows them. */
function loadModels() {
  if (!S.hub) api('GET', '/settings').then((r) => { S.hub = r }).catch(() => {})
  return api('GET', '/models').then((r) => { takeModels(r); paintComposerChips(); paintChats(); if (openChatView()?.chat) paintConvo(S.openChat) }).catch(() => {})
}

/**
 * The hub came back running newer Limeade code (a restart after an update): load it, so an open page
 * doesn't keep showing the old one. Not while he's typing; he gets a note instead.
 */
async function reloadIfUpdated() {
  const mine = document.querySelector('script[src^="/app."]')?.getAttribute('src')
  if (!mine) return
  const html = await fetch('/', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).catch(() => '')
  if (!/"\/app\.[0-9a-f]{10}\.js"/.test(html) || html.includes(`"${mine}"`)) return
  if ([...document.querySelectorAll('.composer textarea')].some((t) => t.value.trim())) return toast('Limeade was updated. Reload to get the new version.')
  location.reload()
}

function paintConn() {
  // Quiet unless the hub has been out of reach for a few seconds.
  clearTimeout(paintConn.timer)
  if (S.connected) $('#conn').hidden = true
  else paintConn.timer = setTimeout(() => { $('#conn').hidden = S.connected }, 4000)
}

// When the app comes back to the screen, make sure the stream is alive and the thread is current.
document.addEventListener('visibilitychange', () => {
  syncWatching()
  if (document.visibilityState !== 'visible') return
  if (!es || es.readyState === EventSource.CLOSED) connect()
  loadAssistant()
  loadWorkers()
  openChatView()?.load()
  if (S.tab === 'chat') loadChats()
  if (S.tab === 'assistant') { markSeen(); markSeenOnScreen() }
})
// Safety net: while a turn runs, re-read the thread every 15 s, so a lost event never leaves "Running".
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  if (S.assistant.chat?.busy) loadAssistant()
  if (openChatView()?.chat?.busy) S.openChat.load()
}, 15000)
setInterval(() => { if (document.visibilityState === 'visible' && S.tab === 'workers') loadWorkers() }, 4000)
setInterval(() => { if (document.visibilityState === 'visible' && S.tab !== 'workers') loadWorkers() }, 30000)

// ---------- Assistant ----------

async function loadAssistant() {
  try {
    const [chat, ap] = await Promise.all([api('GET', '/chats/assistant'), api('GET', '/approvals')])
    S.assistant.chat = chat
    liveTurn.settle(S.assistant)
    S.assistant.approvals = ap.approvals.filter((a) => a.chatId === 'assistant')
    S.assistant.error = null
  } catch (e) {
    S.assistant.error = e.message
  }
  paintThread()
  paintComposerChips()
}

function markSeen() {
  S.seenAt = Date.now()
  localStorage.setItem('assistantSeen', String(S.seenAt))
  paintBadges()
}

function paintBadges() {
  const A = S.assistant
  // Replies that land while the Assistant is on screen count as read straight away.
  if (S.tab === 'assistant' && document.visibilityState === 'visible') { S.seenAt = Date.now(); localStorage.setItem('assistantSeen', String(S.seenAt)) }
  const unread = (A.chat?.messages || []).filter((m) => m.role === 'assistant' && new Date(m.at).getTime() > S.seenAt).length + A.approvals.length
  const set = (id, n) => { const b = $(id); if (b) { b.hidden = !n; b.textContent = n } }
  set('#badge-assistant', S.tab === 'assistant' && document.visibilityState === 'visible' ? 0 : unread)
  set('#bell-count', S.inbox.length)
}

let speaking = null
function speak(m, btn) {
  if (!('speechSynthesis' in window)) return toast("This browser can't read aloud")
  speechSynthesis.cancel()
  if (speaking === m.id) { speaking = null; return paintThreads() }
  const u = new SpeechSynthesisUtterance(window.md.plain(m.text))
  u.onend = () => { speaking = null; paintThreads() }
  speaking = m.id
  speechSynthesis.speak(u)
  paintThreads()
}

/**
 * One conversation on screen (the Assistant, or a chat on the Chat page): its thread box, what's streaming
 * and the approvals waiting in it. `after` runs after each paint.
 */
function convo(id, box, { empty, after } = {}) {
  const V = { id, box, chat: null, streaming: {}, liveSteps: {}, approvals: [], error: null, toBottom: false, once: false, empty, after }
  // Follow the end of the thread unless the user scrolled up to read (only their own scrolling counts).
  V.end = threadEnd.follow(box)
  return V
}

/** Applies a live event to a conversation; false when it isn't about it. */
function applyEvent(V, name, d) {
  if (!V?.chat || d.chatId !== V.id) return false
  if (name === 'message') {
    V.chat.messages = [...V.chat.messages.filter((m) => m.id !== d.message.id), d.message]
    delete V.streaming[d.message.id]
    delete V.liveSteps[d.message.id]
  } else if (name === 'delta') {
    V.streaming[d.messageId] = liveTurn.addPiece(V.streaming[d.messageId], d.text, d.at)
  } else if (name === 'live') {
    // A turn picked up after a hub restart: everything it has said so far, in place of what we had.
    V.streaming[d.messageId] = d.text || ''
    V.liveSteps[d.messageId] = d.steps || []
    if (!d.text) delete V.streaming[d.messageId]
  } else if (name === 'step') {
    ;(V.liveSteps[d.messageId] ||= []).push(d.step)
  } else if (name === 'busy') {
    V.chat.busy = !!d.busy
    if (!V.chat.busy) liveTurn.settle(V)
  } else if (name === 'approval') {
    V.approvals = [...V.approvals.filter((a) => a.id !== d.id), d]
  } else return false
  return true
}

function paintThread() { paintConvo(S.assistant) }
/** Repaints every conversation on screen (e.g. a read-aloud button changed). */
function paintThreads() { paintThread(); if (S.openChat) paintConvo(S.openChat) }

function paintConvo(V) {
  const box = V.box
  const A = V
  const atBottom = V.end.stuck
  box.replaceChildren()
  if (!A.chat) {
    box.append(h('div', { class: 'empty' }, A.error || 'Connecting…'))
    return V.after?.()
  }
  const msgs = A.chat.messages
  if (!msgs.length && !A.chat.busy && !A.approvals.length && V.empty) {
    box.append(h('div', { class: 'empty' }, typeof V.empty === 'function' ? V.empty() : V.empty))
  }
  let last = 0
  for (const m of msgs) {
    const t = new Date(m.at).getTime()
    if (!last || t - last >= 10 * 60000) box.append(h('div', { class: 'divider' }, timeLabel(m.at)))
    last = t
    if (m.role === 'user') box.append(userMessage(m, V.id))
    else if (m.role === 'event') box.append(h('div', { class: 'event-line' }, m.text))
    else if (m.role === 'error') box.append(h('div', { class: 'error-line' }, m.text))
    else box.append(reply(m))
    box.lastChild.dataset.id = m.id
  }
  V.live = h('div', { class: 'live-turn' })
  box.append(V.live)
  paintLive(V)
  for (const a of A.approvals) box.append(approvalCard(a, V))
  if (atBottom || V.toBottom || !V.once) V.end.toEnd()
  V.toBottom = false
  V.once = true
  V.after?.()
}

/** The running turn at the bottom of a thread: what it's doing and what it has said so far. */
function paintLive(V) {
  const A = V
  if (!V.live) return
  if (!(A.chat.busy || Object.keys(A.streaming).length)) return V.live.replaceChildren()
  const ids = Object.keys(A.streaming).length ? Object.keys(A.streaming) : Object.keys(A.liveSteps)
  const id = ids[ids.length - 1]
  const now = liveTurn.untag(A.streaming[id])
  put(V.live, progressLine(A.liveSteps[id] || []),
    now ? h('div', { class: 'reply' }, h('div', { class: 'md reply-card', html: window.md.render(now) })) : null)
}

/**
 * Streamed text arrives many times a second. Repainting the whole thread (and every message's markdown)
 * for each piece is what froze typing; instead only the live reply is redrawn, at most every 100 ms and
 * in an animation frame, and the composer is never touched.
 */
function liveSoon(V) {
  if (V.liveTimer) return
  const wait = Math.max(0, 100 - (performance.now() - (V.liveAt || 0)))
  V.liveTimer = setTimeout(() => requestAnimationFrame(() => {
    V.liveTimer = null
    V.liveAt = performance.now()
    if (!V.chat) return
    if (!V.live?.isConnected || V.live.parentNode !== V.box) return paintConvo(V)
    paintLive(V)
    V.end.keep()
  }), wait)
}

/** The user's message: their photos as thumbnails and other files as cards, then the text. */
function userMessage(m, chatId) {
  const files = m.attachments || []
  if (!files.length) return h('div', { class: 'bubble' }, m.text)
  const url = (a) => `/chats/${encodeURIComponent(chatId)}/attachments/${a.id}`
  return h('div', { class: 'sent' },
    h('div', { class: 'sent-files' }, files.map((a) => isPhoto(a.type)
      ? h('a', { class: 'thumb', href: url(a), target: '_blank', rel: 'noopener', 'aria-label': a.name }, h('img', { src: url(a), alt: a.name, loading: 'lazy' }))
      : h('a', { class: 'file-card', href: url(a), download: a.name }, svg(ICON.file), h('span', {}, h('span', { class: 'fname' }, a.name), h('span', { class: 'fmeta' }, fileMeta(a)))))),
    m.text ? h('div', { class: 'bubble' }, m.text) : null)
}
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const isPhoto = (type) => PHOTO_TYPES.includes(type)
function fileMeta(a) {
  const ext = (a.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'file').toUpperCase()
  const kb = a.size / 1024
  return `${ext} · ${kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`}`
}

function reply(m) {
  return h('div', { class: 'reply' },
    m.steps?.length ? statusLine(m.steps, false) : null,
    m.text ? h('div', { class: 'md reply-card', html: window.md.render(m.text) }) : null,
    h('div', { class: 'reply-actions' },
      h('button', { 'aria-label': 'Copy', onclick: () => navigator.clipboard?.writeText(m.text).then(() => toast('Copied')) }, svg(ICON.copy)),
      h('button', { 'aria-label': 'Read aloud', class: speaking === m.id ? 'on' : '', onclick: () => speak(m) }, svg(speaking === m.id ? ICON.stop : ICON.speak)),
    ),
  )
}

/**
 * While a turn runs: one line that follows its latest step ("Reading notes.md…", "Starting a worker…"),
 * with the soft light sweep the Claude apps use on in-progress text. When the turn ends the reply shows
 * the usual collapsed "Ran 3 commands ›" line instead.
 */
function progressLine(steps) {
  const last = steps[steps.length - 1]
  const text = `${last ? last.label || statusLabel([last], false) : 'Thinking'}…`
  return h('button', { class: 'status-line live', onclick: steps.length ? () => stepsSheet(steps, true) : null },
    h('span', { class: 'shimmer' }, text))
}

function statusLine(steps, running) {
  const text = statusLabel(steps, running)
  if (!text) return null
  return h('button', { class: 'status-line', onclick: steps.length ? () => stepsSheet(steps, running) : null }, text, steps.length ? svg(ICON.chevR) : null)
}

function stepsSheet(steps, running) {
  sheet(running ? 'Running' : statusLabel(steps, false), null, h('div', { class: 'steps' },
    steps.map((s) => h('div', { class: 'step' }, s.label || s.tool))))
}

function approvalCard(a, V) {
  const card = h('div', { class: 'approval', 'data-approval': a.id })
  const answer = async (decision, message) => {
    card.replaceChildren(h('div', { class: 'working' }, h('span', { class: 'spin' })))
    try {
      await api('POST', `/approvals/${a.id}`, { decision, ...(message ? { message } : {}) })
      V.approvals = V.approvals.filter((x) => x.id !== a.id)
      paintConvo(V)
    } catch (e) { toast(e.message); paintConvo(V) }
  }
  const tellIt = () => {
    const input = h('input', { class: 'grow', placeholder: 'What should it do instead?', style: 'flex:1;height:44px;padding:0 12px;border-radius:12px;border:1px solid var(--line2);background:var(--bg);outline:0' })
    const send = () => answer('no', input.value.trim() || undefined)
    input.addEventListener('keydown', (e) => e.key === 'Enter' && send())
    opts.replaceChildren(h('div', { class: 'instead' }, input, h('button', { class: 'round fill', 'aria-label': 'Send', onclick: send }, svg(ICON.up))))
    input.focus()
  }
  const opts = h('div', {},
    h('button', { class: 'opt first', onclick: () => answer('yes') }, h('span', { class: 'n' }, '1'), 'Yes'),
    a.alwaysLabel ? h('button', { class: 'opt', onclick: () => answer('always') }, h('span', { class: 'n' }, '2'),
      h('span', {}, "Yes, and don't ask again for ", h('span', { class: 'mono' }, a.alwaysLabel), ' here')) : null,
    h('button', { class: 'opt', onclick: tellIt }, h('span', { class: 'n' }, a.alwaysLabel ? '3' : '2'), 'No, and tell it what to do differently'),
  )
  card.append(
    h('div', { class: 'who' }, `${a.chatTitle} wants to ${a.tool === 'Bash' ? 'run' : `use ${a.tool}`}`),
    h('div', { class: 'cmd' }, h('span', { class: 'tool-tag mono' }, a.tool), h('span', { class: 'mono' }, a.text || a.description)),
    opts,
  )
  return card
}

// ---------- composer (Assistant and Toolbox "Change it…") ----------

const MAX_FILE_MB = 20
const MAX_FILES = 5

function composer({ hint, onSend, chips, busy, onStop, upload }) {
  const ta = h('textarea', { rows: 1, placeholder: hint, enterkeyhint: 'enter' })
  const chipsBox = h('div', { class: 'chips' })
  const action = h('button', { class: 'round' })
  // Files (with `upload`): picked with +, uploaded at once, sent with the next message.
  const tray = h('div', { class: 'tray', hidden: true })
  const picker = h('input', { type: 'file', hidden: true, multiple: true })
  const plus = upload ? h('button', { class: 'round plus', 'aria-label': 'Add photos and files', onclick: () => attachSheet() }, svg(ICON.plus)) : null
  const el = h('div', { class: 'composer' }, tray, ta, h('div', { class: 'row' }, plus, chipsBox, action), picker)
  let files = [] // { key, file, preview, done: attachment | null, error }
  let listening = null
  let sending = false
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden' }
  const uploading = () => files.some((f) => !f.done)
  const send = async () => {
    const text = ta.value.trim()
    if ((!text && !files.length) || sending) return
    if (uploading()) return toast('Still uploading…')
    sending = true
    paint()
    try {
      await onSend(text, files.map((f) => f.done))
      // Anything he typed while it was sending stays.
      if (ta.value.trim() === text) ta.value = ''
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview)
      files = []
      paintTray()
      grow()
    } catch (e) { toast(e.message) } finally { sending = false; paint() }
  }
  function attachSheet() {
    // The input is clicked inside the tap itself (phones only open pickers from a tap).
    const pick = (accept, capture) => () => {
      picker.accept = accept
      if (capture) picker.setAttribute('capture', 'environment'); else picker.removeAttribute('capture')
      picker.multiple = !capture
      picker.click()
      el2.close()
    }
    const row = (icon, name, hint2, onclick) => h('button', { class: 'pick attach-pick', onclick }, svg(icon), h('span', {}, h('div', { class: 'name' }, name), h('div', { class: 'hint2' }, hint2)))
    const el2 = sheet('Add to message', `Up to ${MAX_FILES} files, ${MAX_FILE_MB} MB each.`,
      row(ICON.photo, 'Photos', 'Pictures and screenshots from your library', pick('image/*')),
      row(ICON.camera, 'Camera', 'Take a photo now', pick('image/*', true)),
      row(ICON.file, 'Files', 'PDFs, text, spreadsheets, documents', pick('')))
  }
  picker.addEventListener('change', () => {
    const picked = [...picker.files]
    picker.value = ''
    addFiles(picked)
  })
  // Paste: files (a screenshot, a copied image) attach like picked ones; text pastes as text.
  if (upload) ta.addEventListener('paste', (e) => {
    const pasted = clip.filesFrom(e.clipboardData)
    if (!pasted.length) return
    e.preventDefault()
    addFiles(pasted)
  })
  /** Picked, pasted or dropped files: checked, uploaded at once, shown in the tray. */
  function addFiles(list) {
    for (const file of list) {
      if (files.length >= MAX_FILES) { toast(`Up to ${MAX_FILES} files per message`); break }
      if (file.size > MAX_FILE_MB * 1024 * 1024) { toast(`${file.name} is over ${MAX_FILE_MB} MB`); continue }
      const f = { key: Math.random(), file, preview: PHOTO_TYPES.includes(file.type) ? URL.createObjectURL(file) : null, done: null }
      files.push(f)
      upload(file).then((a) => { f.done = a }).catch((e) => {
        toast(`${file.name}: ${e.message}`)
        files = files.filter((x) => x !== f)
      }).finally(() => { paintTray(); paint() })
    }
    paintTray()
    paint()
  }
  function paintTray() {
    tray.hidden = !files.length
    put(tray, files.map((f) => h('div', { class: 'tray-item' + (f.preview ? ' photo' : '') },
      f.preview ? h('img', { src: f.preview, alt: f.file.name }) : h('div', { class: 'tray-file' }, svg(ICON.file), h('span', { class: 'fname' }, f.file.name)),
      f.done ? null : h('div', { class: 'tray-wait' }, h('span', { class: 'spin' })),
      h('button', { class: 'tray-x', 'aria-label': `Remove ${f.file.name}`, onclick: () => {
        if (f.preview) URL.revokeObjectURL(f.preview)
        files = files.filter((x) => x !== f)
        paintTray()
        paint()
      } }, svg(ICON.close)))))
  }
  const mic = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return toast("This browser can't take dictation")
    if (listening) { listening.stop(); return }
    const r = new SR()
    r.interimResults = true
    r.lang = navigator.language || 'en-US'
    const before = ta.value.trim()
    r.onresult = (e) => {
      const said = [...e.results].map((x) => x[0].transcript).join('')
      ta.value = before ? `${before} ${said}` : said
      grow()
    }
    r.onend = () => { listening = null; paint() }
    r.onerror = () => { listening = null; paint() }
    listening = r
    r.start()
    paint()
  }
  function paint() {
    const hasText = ta.value.trim().length > 0 || files.length > 0
    action.replaceChildren()
    action.onclick = null
    if (hasText) { action.className = 'round fill'; action.append(svg(ICON.up)); action.onclick = send; action.disabled = sending; action.ariaLabel = 'Send' }
    else if (el.busy && onStop) { action.className = 'round'; action.append(svg(ICON.stop)); action.onclick = onStop; action.ariaLabel = 'Stop' }
    else { action.className = 'round' + (listening ? ' live' : ''); action.append(svg(ICON.mic)); action.onclick = mic; action.ariaLabel = 'Speak' }
  }
  ta.addEventListener('input', () => { grow(); paint() })
  // Enter sends on a computer; on phones Enter is a new line (the arrow sends).
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover: hover) and (pointer: fine)').matches) { e.preventDefault(); send() }
  })
  el.setChips = (list) => chipsBox.replaceChildren(...list)
  el.setBusy = (b) => { el.busy = b; paint() }
  el.addFiles = upload ? addFiles : null
  el.busy = !!busy
  if (chips) el.setChips(chips)
  paint()
  return el
}

function chip(label, soft, onclick, icon) {
  return h('button', { class: 'chip', onclick }, icon ? svg(icon) : null, h('span', {}, label),
    soft ? h('span', { class: 'soft' }, soft) : null, svg(ICON.chevD))
}

/** `agent` (chats and the Assistant): the chat's agent, and the sheet lets him switch it. */
function modelChip(model, effort, onPick, forAssistant, agent) {
  const pick = () => modelSheet(model, effort, onPick, forAssistant, agent)
  if (modelRemoved(model)) {
    const el = chip(byWidth('Model removed — pick another', 'Model removed'), null, pick)
    el.classList.add('warn')
    return el
  }
  const label = modelLabel(model)
  const codex = agent === 'codex' ? 'Codex · ' : ''
  // A phone shows the model's short name only; the agent and effort are in the sheet.
  const el = chip(byWidth(codex + label, shortModelLabel(label)), takesEffort(model) ? cap(effort) : null, pick)
  el.classList.add('model')
  return el
}

/** The model list and which agents this hub has (Codex: installed, signed in). */
function takeModels(r) {
  S.models = r.groups
  S.agents = r.agents || { claude: { installed: true, signedIn: true } }
}

/** Claude's and Codex's own models take an effort level; local ones don't. */
const takesEffort = (id) => /^(claude|codex):/.test(id || '')
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' }
/** Under an agent in the picker when it can't run its own models yet. */
const agentNote = (st) => (!st ? null : !st.installed ? 'not installed' : !st.signedIn ? 'not signed in' : null)
const agentName = (agent) => AGENT_NAMES[agent || 'claude']
/** Which model groups an agent runs: its own, and local models. */
const agentRuns = (agent, g) => g.engine === 'local' || g.engine === (agent || 'claude')

S.assistant = convo('assistant', $('#thread'), {
  empty: 'Your assistant. Ask it to start work; worker news shows up here.',
  after: () => { paintBadges(); markSeenOnScreen(); paintComposerAction() },
})

const assistantComposer = composer({
  hint: 'Message…',
  upload: (file) => api('POST', `/chats/assistant/attachments?name=${encodeURIComponent(file.name || 'photo.jpg')}`, file),
  onSend: async (text, files = []) => {
    // "/new" starts a fresh agent conversation (the next turn reads the handoff, where there is one).
    if (text === '/new') { await api('POST', '/chats/assistant/new-session'); await loadAssistant(); return toast('Started fresh') }
    S.assistant.toBottom = true // his own message: always follow the thread to the end
    const m = await api('POST', '/chats/assistant/messages', { text, ...(files.length ? { attachments: files.map((a) => a.id) } : {}) })
    const chat = S.assistant.chat
    if (chat && !chat.messages.some((x) => x.id === m.id)) { chat.messages.push(m); chat.busy = true }
    paintThread()
  },
  onStop: () => api('POST', '/chats/assistant/stop').catch((e) => toast(e.message)),
})
$('#assistant-composer').append(assistantComposer)

// Files dragged onto a chat (on a computer) attach like picked ones.
function acceptDrops(view, into) {
  let depth = 0 // dragenter/leave fire for every child crossed
  const lit = (on) => view.classList.toggle('drop', on)
  view.addEventListener('dragenter', (e) => { if (!clip.dragHasFiles(e.dataTransfer)) return; depth++; lit(true) })
  view.addEventListener('dragleave', () => { if (depth && !--depth) lit(false) })
  view.addEventListener('dragover', (e) => { if (clip.dragHasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } })
  view.addEventListener('drop', (e) => {
    depth = 0
    lit(false)
    if (!clip.dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    into.addFiles(clip.filesFrom(e.dataTransfer))
  })
}
acceptDrops($('#view-assistant'), assistantComposer)

function paintComposerChips() {
  const chat = S.assistant.chat
  if (!chat) return
  const update = (patch) => api('PATCH', '/chats/assistant', patch).then((c) => {
    const was = S.assistant.chat.agent || 'claude'
    Object.assign(S.assistant.chat, { model: c.model, effort: c.effort, mode: c.mode, agent: c.agent })
    if ((c.agent || 'claude') !== was) toast(`${agentName(c.agent)} takes it from here, with the recent conversation`)
    paintComposerChips()
  }).catch((e) => toast(e.message))
  const mode = MODES.find((m) => m[0] === chat.mode) || MODES[2]
  assistantComposer.setChips([
    modelChip(chat.model, chat.effort, (model, effort, agent) => update({ model, effort, agent }), true, chat.agent || 'claude'),
    modeChip(mode[3], () => modeSheet(chat.mode, (m) => update({ mode: m }))),
  ])
}
/** The mode chip: shield and one short word, never cut. */
function modeChip(label, onclick) {
  const el = chip(label, null, onclick, ICON.shield)
  el.classList.add('mode')
  return el
}
function paintComposerAction() { assistantComposer.setBusy(!!S.assistant.chat?.busy) }

// ---------- sheets and dialogs ----------

function sheet(title, subtitle, ...body) {
  const root = $('#sheet-root')
  // Our own step back after closing: the popstate it fires must not also close the page under the sheet.
  const close = () => { root.replaceChildren(); if (history.state?.sheet) { sheetClosing = true; history.back() } }
  const el = h('div', { class: 'sheet', role: 'dialog' }, h('div', { class: 'handle' }), h('h2', {}, title), subtitle ? h('div', { class: 'subtitle' }, subtitle) : null, ...body)
  root.replaceChildren(h('div', { class: 'scrim', onclick: close }), el)
  history.pushState({ sheet: true }, '')
  el.close = close
  return el
}

function dialog({ title, text, ok, danger, onOk, cancel = true }) {
  const root = $('#sheet-root')
  const close = () => root.replaceChildren()
  root.replaceChildren(
    h('div', { class: 'scrim', onclick: cancel ? close : null }),
    h('div', { class: 'dialog', role: 'alertdialog' }, h('h3', {}, title), h('p', {}, text),
      h('div', { class: 'acts' },
        cancel ? h('button', { onclick: close }, 'Cancel') : null,
        h('button', { class: danger ? 'danger' : '', onclick: () => { close(); onOk() } }, ok))),
  )
}

/**
 * `forAssistant`: true for the Assistant and Chat page, false for Toolbox drafts. `agent` (chats and the
 * Assistant) adds the agent switch: Claude Code or Codex; onPick then gets the agent too.
 */
async function modelSheet(model, effort, onPick, forAssistant, agent) {
  let cur = model
  let eff = effort
  let ag = agent || 'claude'
  // The switch shows once the hub says it has Codex (installed or not); Toolbox drafts never switch.
  const switchable = () => agent !== undefined && !!S.agents?.codex
  const list = h('div')
  const sub = h('div', { class: 'subtitle' })
  const el = sheet(forAssistant ? 'Model' : `Models on ${hubName()}`, null, sub, list)
  const pick = (id) => { cur = id; onPick(cur, eff, ag) }
  // A model this agent runs (its own or local), or none.
  const fits = (id) => S.models.some((g) => agentRuns(ag, g) && g.models.some((m) => m.id === id))
  const paint = () => {
    sub.textContent = !forAssistant ? 'Claude runs on your subscription; the rest run on your machines.'
      : ag === 'codex' ? 'Codex runs its own models on your OpenAI sign-in, or a local model on your machines.'
      : 'Claude runs on your subscription; local models run on your machines.'
    list.replaceChildren()
    if (switchable()) {
      const codex = S.agents.codex
      list.append(h('div', { class: 'section' }, 'Agent'), h('div', { class: 'efforts agents' }, ['claude', 'codex'].map((a) =>
        h('button', {
          class: a === ag ? 'on' : '', disabled: a !== ag && !S.agents[a]?.installed,
          onclick: () => {
            if (a === ag) return
            ag = a
            // The model stays when the new agent runs it too (a local model); otherwise he picks one.
            if (fits(cur)) onPick(cur, eff, ag)
            paint()
          },
        }, AGENT_NAMES[a], agentNote(S.agents[a]) ? h('span', { class: 'agent-note' }, agentNote(S.agents[a])) : null))))
      const setUp = (agentId) => h('button', { class: 'linkbtn', onclick: () => {
        addEventListener('popstate', () => setTimeout(() => openAgentSetup(agentId)), { once: true })
        el.close()
      } }, 'Set it up')
      if (!codex.installed) list.append(h('div', { class: 'hint picker-foot' }, "Codex isn't installed on this box yet. ", setUp('codex')))
      else if (ag === 'codex' && !codex.signedIn) list.append(h('div', { class: 'hint picker-foot' }, "Codex isn't signed in, so its own models are off. Local models work in it now. ", setUp('codex')))
      if (ag === 'claude' && agentNote(S.agents.claude)) list.append(h('div', { class: 'hint picker-foot' }, `Claude Code is ${agentNote(S.agents.claude)}, so Claude's models are off. Local models still chat. `, setUp('claude')))
      if (!fits(cur)) list.append(h('div', { class: 'hint picker-foot' }, `Pick a model for ${AGENT_NAMES[ag]}.`))
    }
    for (const g of S.models) {
      if (!agentRuns(ag, g)) continue
      list.append(h('div', { class: 'section' }, g.online || g.engine !== 'local' ? g.title : `${g.title} · offline`))
      for (const m of g.models) {
        list.append(h('button', {
          class: 'pick' + (m.id === cur ? ' on' : ''), disabled: !g.online,
          onclick: () => { pick(m.id); if (takesEffort(m.id)) paint(); else el.close() },
        }, h('span', { class: 'radio' }), h('span', {}, h('div', { class: 'name' }, m.label, forAssistant && m.chatOnly ? h('span', { class: 'default-tag' }, 'Chat only') : null), m.hint ? h('div', { class: 'hint2' }, m.hint) : null)))
      }
      if (g.engine !== 'local' && cur.startsWith(`${g.engine}:`)) {
        list.append(h('div', { class: 'efforts' }, ['low', 'medium', 'high'].map((e) =>
          h('button', { class: e === eff ? 'on' : '', onclick: () => { eff = e; onPick(cur, eff, ag); paint() } }, cap(e)))))
      }
    }
    if (!S.models.length) list.append(h('div', { class: 'working' }, h('span', { class: 'spin' })))
    if (forAssistant) {
      list.append(h('div', { class: 'hint picker-foot' }, 'Add more in ', h('button', { class: 'linkbtn', onclick: () => {
        // Open the page once the sheet's own step back has happened, so back closes the page, not the sheet.
        addEventListener('popstate', () => setTimeout(openLocalModels), { once: true })
        el.close()
      } }, 'Local Models')))
    }
  }
  paint()
  try { takeModels(await api('GET', '/models')); paint() } catch (e) { toast(e.message) }
}

function modeSheet(mode, onPick) {
  const el = sheet('When to ask you', 'For this conversation.', MODES.map(([id, name, desc]) =>
    h('button', { class: 'pick' + (id === mode ? ' on' : ''), onclick: () => { onPick(id); el.close() } },
      h('span', { class: 'radio' }),
      h('span', {}, h('div', { class: 'name' }, name, id === 'auto' ? h('span', { class: 'default-tag' }, 'Default') : null), h('div', { class: 'hint2' }, desc)))))
}

// ---------- local models: add and remove Ollama models on the user's machines ----------

/** Machines with their installed models and pulls; the library and each model's tags (read by the hub). */
S.local = { machines: null, error: null, library: null, tags: {} }
const localViews = new Set() // repaint functions of the open local-model pages

async function loadLocalMachines() {
  try { S.local.machines = (await api('GET', '/local-models')).machines; S.local.error = null } catch (e) { S.local.error = e.message }
  for (const paint of localViews) paint()
}

function onLocalEvent(name, d) {
  if (name === 'pull' && S.local.machines) {
    const m = S.local.machines.find((x) => x.id === d.machine)
    if (m) m.pull = d
    if (d.state === 'done') toast(isEmbeddingRef(d.tag) ? `${d.tag} is ready` : `${d.tag} is ready to pick`)
    if (d.state === 'failed') toast(`${d.tag} didn't download: ${d.error || 'failed'}`)
  }
  if (name === 'local_models' || (name === 'pull' && d.state !== 'pulling')) {
    api('GET', '/models').then((r) => { takeModels(r); paintComposerChips() }).catch(() => {})
    if (localViews.size) return loadLocalMachines()
  }
  for (const paint of localViews) paint()
}

/** Opens a page whose paint runs again on every local-model change while it's open.
 *  Wide windows: a whole page in the main area, like Settings, with Local models lit in the sidebar. */
function localPage(build) {
  openPage((page) => {
    page.classList.add('full-page', 'models-page')
    const paint = build(page)
    localViews.add(paint)
    new MutationObserver((_, obs) => { if (!page.isConnected) { localViews.delete(paint); obs.disconnect() } }).observe($('#pages'), { childList: true })
    paint()
  })
}

/** Whether the library says this model (or tag) is an embedding model. */
const isEmbeddingRef = (ref) => !!S.local.library?.models?.some((x) => x.name === ref.split(':')[0] && x.capabilities.includes('embedding'))

const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)

function pullRow(m) {
  const p = m.pull
  if (!p) return null
  if (p.state === 'pulling') {
    return h('div', { class: 'cardrow pullrow' },
      h('div', { class: 'grow' },
        h('div', { class: 'mono' }, `Downloading ${p.tag}`),
        h('div', { class: 'progress' }, h('span', { style: `width:${p.percent}%` })),
        h('div', { class: 'small' }, p.total ? `${gb(p.completed)} of ${gb(p.total)} · ${p.percent}%` : cap(p.status || 'starting'))),
      h('button', { class: 'linkbtn', onclick: () => api('POST', `/local-models/${m.id}/cancel`).catch((e) => toast(e.message)) }, 'Cancel'))
  }
  if (p.state === 'failed') return h('div', { class: 'cardrow' }, h('div', { class: 'grow small' }, `${p.tag} didn't download: ${p.error || 'failed'}`))
  if (p.state === 'cancelled') return h('div', { class: 'cardrow' }, h('div', { class: 'grow small' }, `Stopped downloading ${p.tag}.`))
  return null
}

function openLocalModels() {
  panelClosed()
  localPage((page) => {
    const body = h('div', { class: 'pagebody flush' })
    page.append(pageBar('Local Models', 'Ollama on your machines'), body)
    loadLocalMachines()
    return () => {
      if (S.local.error && !S.local.machines) return put(body, h('div', { class: 'note' }, S.local.error))
      if (!S.local.machines) return put(body, h('div', { class: 'working' }, h('span', { class: 'spin' })))
      put(body, S.local.machines.map((m) => [
        h('div', { class: 'section machine-head' }, h('span', { class: 'dot' + (m.online ? ' on' : '') }),
          [m.label, m.online ? 'online' : 'offline', m.memoryGb ? `${m.memoryGb} GB GPU memory` : '', m.installedLabel && `${m.installedLabel} installed`].filter(Boolean).join(' · ')),
        h('div', { class: 'card' },
          !m.online ? h('div', { class: 'cardrow' }, h('div', { class: 'grow small' }, `${m.label} isn't answering. It may be asleep or off the network; its models stay in the picker.`)) : null,
          pullRow(m),
          m.models.map((x) => h('div', { class: 'cardrow' },
            h('div', { class: 'grow' },
              h('div', { class: 'line1' }, h('span', { class: 'mono' }, x.tag),
                h('span', { class: 'plugin-tag' }, x.kind === 'embedding' ? 'Embedding' : x.tools ? 'tools' : 'Chat only')),
              x.goodFor ? h('div', { class: 'good-for' }, x.goodFor) : null,
              h('div', { class: 'small' }, [x.parameterSize, x.sizeLabel, x.fit.startsWith('Fits') ? null : x.fit,
                x.usedBy?.length ? `Used by ${x.usedBy.join(', ')}` : null].filter(Boolean).join(' · '))),
            h('button', { class: 'iconbtn', 'aria-label': `Remove ${x.tag}`, onclick: () => removeModel(m, x) }, svg(ICON.trash)))),
          m.online && !m.models.length ? h('div', { class: 'cardrow' }, h('div', { class: 'grow small' }, 'No chat models yet.')) : null,
          m.online ? h('button', { class: 'cardrow', disabled: m.pull?.state === 'pulling', onclick: () => openAddModel(m.id) },
            svg(ICON.plus), h('div', { class: 'grow' }, 'Add a model'), svg(ICON.chevR)) : null),
      ]), h('div', { class: 'hint' }, 'Models that can use tools work in Claude Code with your files; the rest are marked Chat only. Embedding models power search tools and stay out of the model picker.'))
    }
  })
}

function removeModel(m, x) {
  const frees = `This deletes it from ${m.label}${x.sizeLabel ? ` and frees ${x.sizeLabel}` : ''}`
  const users = x.usedBy?.join(' and ')
  dialog({
    title: `Remove ${x.tag}?`,
    text: x.kind !== 'embedding' ? `${frees}, and takes ${x.name} out of the model picker. Chats that use it will need another model.`
      : users ? `${users} uses this. ${frees}; ${x.usedBy.length === 1 ? 'its' : 'their'} search will stop working until ${x.usedBy.length === 1 ? "it's" : "they're"} switched to another embedding model.`
      : `${frees}. Nothing on this list uses it, but anything else that embeds with it will stop working.`,
    ok: 'Remove', danger: true,
    onOk: async () => {
      try { await api('DELETE', `/local-models/${m.id}/models/${encodeURIComponent(x.tag)}`); toast(`Removed ${x.tag}`) } catch (e) { toast(e.message) }
      loadLocalMachines()
    },
  })
}

function fitClass(f) { return f ? `fit-${f.fit}` : '' }

function openAddModel(machineId) {
  let query = ''
  localPage((page) => {
    const m0 = S.local.machines.find((x) => x.id === machineId)
    const input = h('input', { type: 'search', placeholder: 'Search models', oninput: (e) => { query = e.target.value.trim().toLowerCase(); paint() } })
    const list = h('div')
    const sub = h('div', { class: 'sub' }, 'From the Ollama library')
    page.append(pageBar(`Add to ${m0.label}`, sub), h('div', { class: 'pagebody flush' }, h('div', { class: 'search' }, svg(ICON.search), input), list))
    if (!S.local.library) {
      api('GET', '/local-models/library').then((r) => { S.local.library = r; paint() }).catch((e) => { S.local.library = { error: e.message, models: [] }; paint() })
    }
    function paint() {
      const m = S.local.machines?.find((x) => x.id === machineId) || m0
      const lib = S.local.library
      if (lib?.fallback) sub.textContent = "ollama.com couldn't be read; a short built-in list"
      if (!lib) return put(list, h('div', { class: 'working' }, h('span', { class: 'spin' })))
      if (lib.error) return put(list, h('div', { class: 'note' }, lib.error))
      const models = lib.models.filter((x) => !query || x.name.includes(query) || x.description.toLowerCase().includes(query))
      const byName = /^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*)?$/i.test(query) && !lib.models.some((x) => x.name === query)
      put(list,
        m.pull?.state === 'pulling' ? h('div', { class: 'card' }, pullRow(m)) : null,
        models.slice(0, 80).map((x) => h('button', { class: 'row-item', onclick: () => modelTagsSheet(m, x) },
          h('div', { class: 'body' },
            h('div', { class: 'line1' }, h('span', { class: 't mono', style: 'flex:initial' }, x.name),
              h('span', { class: 'plugin-tag' }, x.capabilities.includes('embedding') ? 'Embedding' : x.capabilities.includes('tools') ? 'tools' : 'Chat only'),
              x.capabilities.includes('vision') ? h('span', { class: 'plugin-tag' }, 'vision') : null),
            x.goodFor ? h('div', { class: 'good-for' }, x.goodFor) : null,
            x.description ? h('div', { class: 's' }, x.description) : null,
            x.sizes.length ? h('div', { class: 'sizes' }, x.sizes.map((s) => h('span', { class: `size ${fitClass(s.fits[m.id])}`, title: s.fits[m.id]?.label || '' }, s.size))) : null))),
        models.length > 80 ? h('div', { class: 'hint' }, `${models.length - 80} more: search to narrow it down.`) : null,
        byName ? h('button', { class: 'row-item', onclick: () => confirmPull(m, query, null) },
          h('div', { class: 'body' }, h('div', { class: 'line1' }, h('span', { class: 't' }, `Add “${query}” by name`)), h('div', { class: 's' }, 'Any model or tag from ollama.com, as you would type it after ollama pull.'))) : null,
        !models.length && !byName ? h('div', { class: 'note' }, 'No models match.') : null,
        h('div', { class: 'hint' }, `Green sizes fit the ${m.short}, amber ones are tight, grey ones are too big (they run, slowly).`),
      )
    }
    return paint
  })
}

/** One library model: its tags with download sizes and fit on this machine; tap one to add it. */
async function modelTagsSheet(m, x) {
  const list = h('div', {}, h('div', { class: 'working' }, h('span', { class: 'spin' })))
  const el = sheet(x.name, x.description, list)
  let tags
  try { tags = S.local.tags[x.name] ||= (await api('GET', `/local-models/library/${encodeURIComponent(x.name)}`)).tags } catch (e) { return put(list, h('div', { class: 'note' }, e.message)) }
  const have = new Set(m.models.map((i) => i.tag))
  if (!tags.length) return put(list, h('div', { class: 'note' }, 'No downloadable tags found for this model.'))
  put(list, tags.map((t) => {
    const fit = t.fits[m.id]
    const on = have.has(t.tag)
    return h('button', { class: 'pick', disabled: on, onclick: () => { el.close(); setTimeout(() => confirmPull(m, t.tag, t), 0) } },
      h('span', { class: `size big ${fitClass(fit)}` }, t.tag.split(':')[1]),
      h('span', { style: 'flex:1;min-width:0' },
        h('div', { class: 'name mono' }, t.tag, on ? h('span', { class: 'default-tag' }, 'Installed') : null),
        h('div', { class: 'hint2' }, [t.sizeLabel, t.context && `${t.context} context`, fit?.label].filter(Boolean).join(' · '))))
  }), h('div', { class: 'hint' }, x.capabilities.includes('embedding') ? "Embedding model: for search tools. It won't show in the model picker."
    : x.capabilities.includes('tools') ? 'Can use tools: it works in Claude Code with your files.' : "Can't use tools: it will be Chat only."))
}

function confirmPull(m, tag, t) {
  const fit = t?.fits?.[m.id]
  dialog({
    title: `Download ${tag}?`,
    text: `To ${m.label}${t?.sizeLabel ? `, ${t.sizeLabel}` : ''}.${fit && fit.fit !== 'fits' ? ` ${fit.label}: it will run slowly.` : ''} ${isEmbeddingRef(tag) ? "It's an embedding model, so it shows on this page but not in the model picker" : "It shows in the model picker when it's done"}; you can cancel while it downloads.`,
    ok: 'Download',
    onOk: async () => {
      try {
        const p = await api('POST', `/local-models/${m.id}/pull`, { name: tag })
        const mm = S.local.machines?.find((x) => x.id === m.id)
        if (mm) mm.pull = p
        for (const paint of localViews) paint()
      } catch (e) { toast(e.message) }
    },
  })
}

// ---------- pages (pushed over the tabs; the phone's back gesture closes them) ----------

// Wide windows (desktop): the drawer is a fixed sidebar and pages open in a panel beside the list.
const wide = matchMedia('(min-width: 1024px)')
wide.addEventListener('change', () => { if (wide.matches) closeDrawer() })

const pageStack = []
/** `fromList`: opened from a row in a list; on a wide window it takes the panel's place instead of stacking. */
function openPage(build, { fromList = false } = {}) {
  const el = h('div', { class: 'page' })
  if (fromList && wide.matches && pageStack.length) {
    for (const p of pageStack.splice(0)) p.remove()
    pageStack.push(el)
    $('#pages').append(el)
    history.replaceState({ page: 1 }, '')
  } else {
    pageStack.push(el)
    $('#pages').append(el)
    history.pushState({ page: pageStack.length }, '')
  }
  build(el)
  return el
}
function closePage() { if (pageStack.length) history.back() }
/** Wide: switching pages in the sidebar closes the panel, which belonged to the old list. */
function closeAllPages() {
  const n = pageStack.length
  if (!n) return
  for (const p of pageStack.splice(0)) p.remove()
  history.go(-n)
  panelClosed()
}
/** The panel emptied: no list row is the open one any more. */
function panelClosed() {
  if (!S.panelFor) return
  S.panelFor = null
  paintWorkers()
  paintChats()
  if (S.tools) paintToolbox()
}
let drawerClosing = false
let sheetClosing = false
window.addEventListener('popstate', () => {
  if (drawerClosing) { drawerClosing = false; return } // our own step back after closing the drawer
  if (sheetClosing) { sheetClosing = false; return } // likewise after closing a sheet
  if (!drawerRoot.hidden) { drawerRoot.hidden = true; $('#menu').setAttribute('aria-expanded', 'false'); return }
  if ($('#sheet-root').children.length) { $('#sheet-root').replaceChildren(); return }
  const top = pageStack.pop()
  if (top) top.remove()
  if (!pageStack.length) panelClosed()
})
// Wide: Esc closes a sheet or dialog, else the side panel (not while typing in it).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !wide.matches || !drawerRoot.hidden) return
  const root = $('#sheet-root')
  if (root.children.length) { if (history.state?.sheet) history.back(); else root.replaceChildren(); return }
  if (pageStack.length && !/^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName)) closePage()
})

function pageBar(title, sub, ...actions) {
  return h('div', { class: 'pagebar' },
    h('button', { class: 'back', 'aria-label': 'Back', onclick: closePage }, svg(ICON.back)),
    h('div', { class: 'titles' }, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
    ...actions)
}

// ---------- Chat: any model, on a machine and in a folder the user picks ----------

const LOCAL_NOTE = 'Chat only: it can\'t use files or commands, so nothing is written to the folder.'

async function loadChats() {
  try {
    S.chats = (await api('GET', '/chats')).chats
    S.chatsError = null
  } catch (e) { S.chatsError = e.message }
  paintChats()
}

async function loadPlaces() {
  try { S.places = await api('GET', '/places') } catch {}
  return S.places
}

/** "/home/me/dev/x" -> "~/dev/x". */
function shortFolder(path) {
  const home = S.places?.home
  if (home && path === home) return '~'
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path.replace(/^\/home\/[^/]+(?=\/|$)/, '~')
}

/** This computer's name, as the hub is set up ("This computer", or a server's own name). */
const hubName = () => S.hub?.machine || S.places?.machines[0]?.label || 'This computer'

function machineLabel(id) {
  return S.places?.machines.find((m) => m.id === id)?.label || (id === 'homelab' ? hubName() : id)
}

/** The folder chip: "~" or the last folder ("dev", "notes-app"); the header and picker show the whole path. */
function folderName(where) {
  const path = shortFolder(where?.folder || '~/dev')
  return path.split('/').filter(Boolean).pop() || path
}

/** "This computer · ~/dev/notes-app" */
function whereLabel(where) {
  return where ? `${machineLabel(where.machine)} · ${shortFolder(where.folder)}` : hubName()
}

function paintChats() {
  const box = $('#chats')
  if (!box) return
  if (!S.chats) return put(box, S.chatsError ? h('div', { class: 'note' }, S.chatsError) : h('div', { class: 'working' }, h('span', { class: 'spin' })))
  if (!S.chats.length) return put(box, h('div', { class: 'note' }, 'No chats yet. Tap + to talk to any of your models.'))
  put(box, S.chats.map(chatRow))
}

function chatRow(c) {
  const on = S.panelFor === `c:${c.id}`
  return h('div', { class: 'chat-row' + (on ? ' on' : '') },
    h('button', { class: 'row-item' + (on ? ' on' : ''), onclick: () => openChat(c.id, true) },
      h('div', { class: 'body' },
        h('div', { class: 'line1' },
          S.chatBusy?.[c.id] ? h('span', { class: 'state-dot st-working pulse', style: 'margin-top:0' }) : null,
          h('span', { class: 't' }, c.title), h('span', { class: 'ago' }, ago(c.updatedAt))),
        h('div', { class: 'now' }, `${c.agent === 'codex' ? 'Codex · ' : ''}${modelLabel(c.model)} · ${whereLabel(c.where)}`),
        c.preview ? h('div', { class: 's one' }, c.preview) : null)),
    h('button', { class: 'row-more', 'aria-label': `Rename or delete ${c.title}`, onclick: () => chatActions(c) }, svg(ICON.more)))
}

/** A chat was made, renamed or deleted (here or on another device). */
function chatChanged(d) {
  if (!d?.id) return
  if (S.chats) {
    S.chats = S.chats.filter((c) => c.id !== d.id)
    if (!d.deleted) S.chats = [d, ...S.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  const V = openChatView()
  if (V?.id === d.id) {
    if (d.deleted) { toast('That chat was deleted'); closePage() }
    else if (V.chat) { V.chat.title = d.title; V.paintHead() }
  }
  paintChats()
}

/** Messages and busy changes in chats: the list's preview line and working dot. */
let chatsReload = null
function chatListActivity(id, busy) {
  if (busy !== null) { (S.chatBusy ||= {})[id] = busy; paintChats() }
  clearTimeout(chatsReload)
  if (S.chats) chatsReload = setTimeout(loadChats, 500)
}

function openChatView() {
  return S.openChat?.box.isConnected ? S.openChat : null
}

async function newChat() {
  // An untouched new chat on top: open that rather than piling up empty ones.
  const top = S.chats?.[0]
  if (top && !top.preview && top.title === 'New chat') return openChat(top.id, true)
  try {
    // The model (and agent) of the latest chat; the hub puts it in ~/dev on the Homelab.
    const last = S.chats?.[0]
    const chat = await api('POST', '/chats', last ? { model: last.model, ...(last.agent ? { agent: last.agent } : {}) } : {})
    chatChanged({ id: chat.id, title: chat.title, model: chat.model, ...(chat.agent ? { agent: chat.agent } : {}), updatedAt: chat.updatedAt, preview: '', where: chat.where })
    openChat(chat.id, true)
  } catch (e) { toast(e.message) }
}

/** Rename and delete; `extra` rows (the chat page's "When to ask you") go first. */
function chatActions(c, extra = []) {
  const el = sheet(c.title, whereLabel(c.where),
    extra.map(([icon, name, hint2, then]) => h('button', { class: 'pick attach-pick', onclick: () => { el.close(); setTimeout(then, 50) } },
      svg(icon), h('span', {}, h('div', { class: 'name' }, name), h('div', { class: 'hint2' }, hint2)))),
    h('button', { class: 'pick attach-pick', onclick: () => { el.close(); setTimeout(() => renameChat(c), 50) } }, svg(ICON.pencil), h('span', {}, h('div', { class: 'name' }, 'Rename'))),
    h('button', { class: 'pick attach-pick', onclick: () => { el.close(); setTimeout(() => deleteChat(c), 50) } }, svg(ICON.trash), h('span', {}, h('div', { class: 'name' }, 'Delete'))))
}

function renameChat(c) {
  const input = h('input', { value: c.title, maxlength: 80, 'aria-label': 'Chat name' })
  const save = async () => {
    const title = input.value.trim()
    if (!title) return
    try {
      chatChanged(await api('PATCH', `/chats/${c.id}`, { title }).then((x) => ({ ...c, title: x.title, updatedAt: x.updatedAt })))
      el.close()
    } catch (e) { toast(e.message) }
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save())
  const el = sheet('Rename chat', null, h('div', { class: 'field', style: 'margin:6px 16px 12px' }, input),
    h('div', { style: 'padding:0 16px' }, h('button', { class: 'btn primary wide', onclick: save }, 'Save')))
  input.focus()
  input.select()
}

function deleteChat(c) {
  dialog({
    title: 'Delete this chat?', text: 'The conversation goes for good. Files it wrote in the folder stay.', ok: 'Delete', danger: true,
    onOk: async () => {
      try {
        await api('DELETE', `/chats/${c.id}`)
        if (openChatView()?.id === c.id) closePage()
        chatChanged({ ...c, deleted: true })
      } catch (e) { toast(e.message) }
    },
  })
}

/** One chat, as a page: the thread, then the composer with its model, where and mode chips. */
function openChat(id, fromList = false) {
  S.panelFor = `c:${id}`
  paintChats()
  if (!S.places) loadPlaces().then(() => S.openChat?.paintHead())
  openPage((el) => {
    el.classList.add('chat-page')
    // On a phone the ask mode lives here, not on the composer row (it's rarely changed).
    const more = h('button', { class: 'hbtn', 'aria-label': 'Chat options', onclick: () => V.chat && chatActions(V.chat, usesTools() ? [modeRow()] : []) }, svg(ICON.more))
    const bar = pageBar('Chat', ' ', more)
    const box = h('div', { class: 'scroll thread' })
    const host = h('div', { class: 'chat-composer' })
    el.append(listResizer(), bar, box, host)
    // Claude, Codex and local models alike run in an agent (Claude Code or Codex), in this folder; only a chat-only model doesn't.
    const usesTools = () => !isChatOnly(V.chat?.model)
    const V = convo(id, box, {
      empty: () => modelRemoved(V.chat.model)
        ? 'Model removed — pick another. The model this chat used is no longer on your machines.'
        : usesTools()
        ? `${takesEffort(V.chat.model) ? agentName(V.chat.agent) : `${modelLabel(V.chat.model)} in ${agentName(V.chat.agent)}`} works in ${shortFolder(V.chat.where?.folder || '~/dev')} on the ${machineLabel(V.chat.where?.machine || 'homelab')}. Files it writes land there.`
        : `${modelLabel(V.chat.model)} runs on your machines. ${LOCAL_NOTE}`,
      after: () => { comp.setBusy(!!V.chat?.busy); paintChips(); V.paintHead() },
    })
    V.paintHead = () => {
      if (!V.chat) return
      bar.querySelector('h1').textContent = V.chat.title
      bar.querySelector('.sub').textContent = whereLabel(V.chat.where) + (usesTools() ? '' : ' · chat only')
    }
    const update = (patch) => api('PATCH', `/chats/${id}`, patch).then((c) => {
      const was = V.chat.agent || 'claude'
      Object.assign(V.chat, { model: c.model, agent: c.agent, effort: c.effort, mode: c.mode, where: c.where, title: c.title, claudeSession: c.claudeSession, sessionAgent: c.sessionAgent })
      if ((c.agent || 'claude') !== was) {
        chatChanged({ ...(S.chats || []).find((x) => x.id === id), id, title: c.title, model: c.model, agent: c.agent, updatedAt: c.updatedAt, where: c.where })
        if (V.chat.messages.length) toast(`${agentName(c.agent)} takes it from here, with the conversation so far`)
      }
      paintConvo(V)
      return c
    })
    const comp = composer({
      hint: 'Message…',
      upload: (file) => api('POST', `/chats/${id}/attachments?name=${encodeURIComponent(file.name || 'photo.jpg')}`, file),
      onSend: async (text, files = []) => {
        if (V.chat && modelRemoved(V.chat.model)) {
          modelSheet(V.chat.model, V.chat.effort, (model, effort, agent) => update({ model, effort, agent }).catch((e) => toast(e.message)), true, V.chat.agent || 'claude')
          throw new Error('Model removed — pick another')
        }
        V.toBottom = true
        const m = await api('POST', `/chats/${id}/messages`, { text, ...(files.length ? { attachments: files.map((a) => a.id) } : {}) })
        if (V.chat && !V.chat.messages.some((x) => x.id === m.id)) { V.chat.messages.push(m); V.chat.busy = true }
        paintConvo(V)
      },
      onStop: () => api('POST', `/chats/${id}/stop`).catch((e) => toast(e.message)),
    })
    host.append(comp)
    acceptDrops(el, comp)
    const fail = (e) => toast(e.message)
    const pickMode = () => modeSheet(V.chat.mode, (m) => update({ mode: m }).catch(fail))
    const modeOf = (chat) => MODES.find((m) => m[0] === chat.mode) || MODES[2]
    const modeRow = () => [ICON.shield, 'When to ask you', modeOf(V.chat)[1], pickMode]
    const paintChips = () => {
      const chat = V.chat
      if (!chat) return
      const tools = usesTools()
      const mode = tools ? modeChip(modeOf(chat)[3], pickMode) : null
      mode?.classList.add('wide-only') // phones: in the "…" menu
      const whereChip = chip(folderName(chat.where), tools ? null : 'no files written', () => whereSheet(V, update), ICON.folder)
      whereChip.classList.add('where') // the first to give way when the row is tight
      comp.setChips([
        modelChip(chat.model, chat.effort, (model, effort, agent) => update({ model, effort, agent }).catch(fail), true, chat.agent || 'claude'),
        whereChip,
        mode,
      ].filter(Boolean))
    }
    S.openChat = V
    V.load = async () => {
      try {
        const [chat, ap] = await Promise.all([api('GET', `/chats/${id}`), api('GET', '/approvals')])
        V.chat = chat
        liveTurn.settle(V)
        V.approvals = ap.approvals.filter((a) => a.chatId === id)
        V.error = null
      } catch (e) { V.error = e.message }
      paintConvo(V)
    }
    paintConvo(V)
    V.load()
  }, { fromList })
}

/** Machine and folder for a chat. Recent folders first; browse from the current one, or search by name. */
async function whereSheet(V, update) {
  const places = S.places || (await loadPlaces())
  const tools = !isChatOnly(V.chat.model)
  let machine = V.chat.where?.machine || 'homelab'
  let at = null // the folder being browsed: { path, display, parent, folders }
  let query = ''
  let hidden = false
  let found = null
  const machinesBox = h('div')
  const list = h('div')
  const search = h('input', { type: 'search', placeholder: 'Search folders', 'aria-label': 'Search folders', enterkeyhint: 'search' })
  const useBtn = h('button', { class: 'btn primary wide' })
  const el = sheet('Where it works',
    tools ? `${agentName(V.chat.agent)} works in this folder. Files it writes land here.` : 'This model only chats: nothing is written to the folder.',
    machinesBox,
    h('div', { class: 'section' }, 'Folder'),
    h('label', { class: 'search', style: 'display:block;margin:4px 14px 8px' }, svg(ICON.search), search),
    list,
    h('div', { style: 'padding:12px 16px 0' }, useBtn))

  const choose = async (path) => {
    const had = !!V.chat.claudeSession && tools && path !== V.chat.where?.folder
    try {
      const c = await update({ where: { machine, folder: path } })
      el.close()
      toast(`Working in ${shortFolder(c.where.folder)}${had ? '; the conversation starts fresh there' : ''}`)
      S.places = null // recent folders changed
    } catch (e) { toast(e.message) }
  }
  const row = (f, onclick, extra) => h('button', { class: 'pick folder-pick', onclick },
    svg(ICON.folder), h('span', { class: 'grow' }, h('div', { class: 'name mono' }, f.name || f.display), f.name ? h('div', { class: 'hint2 mono' }, f.display) : null), extra || null)

  // Only one machine (Homelab) today: no choice to show. A second one brings the section back.
  const paintMachines = () => (places?.machines || []).length < 2 ? put(machinesBox) : put(machinesBox, h('div', { class: 'section' }, 'Machine'), places.machines.map((m) =>
    h('button', { class: 'pick' + (m.id === machine ? ' on' : ''), disabled: !m.online, onclick: () => { machine = m.id; paintMachines() } },
      h('span', { class: 'radio' }),
      h('span', {}, h('div', { class: 'name' }, m.label), h('div', { class: 'hint2' }, m.online ? (m.kind === 'this-box' ? 'This server' : 'Online') : m.note || 'Offline')))))

  const paintList = () => {
    useBtn.textContent = at ? `Use ${at.display}` : 'Use this folder'
    useBtn.disabled = !at
    useBtn.onclick = () => at && choose(at.path)
    if (query) {
      if (!found) return put(list, h('div', { class: 'working' }, h('span', { class: 'spin' })))
      return put(list, found.length
        ? found.map((f) => row({ display: f.display }, () => { search.value = ''; query = ''; browse(f.path) }))
        : h('div', { class: 'hint', style: 'padding-bottom:8px' }, 'No folders match.'))
    }
    const recent = (places?.recent || []).filter((f) => f.path !== at?.path)
    put(list,
      recent.length ? [h('div', { class: 'hint' }, 'Recent'), recent.map((f) => row({ display: f.display }, () => choose(f.path)))] : null,
      at ? [
        h('div', { class: 'hint', style: 'display:flex;gap:8px;align-items:center' },
          h('span', { class: 'grow mono', style: 'flex:1;color:var(--muted)' }, at.display),
          h('button', { class: 'linkbtn', style: 'font-size:13.5px', onclick: () => { hidden = !hidden; browse(at.path) } }, hidden ? 'Hide hidden folders' : 'Show hidden folders')),
        at.parent ? h('button', { class: 'pick folder-pick', onclick: () => browse(at.parent.path) }, svg(ICON.back), h('span', {}, h('div', { class: 'name' }, 'Up'), h('div', { class: 'hint2 mono' }, at.parent.display))) : null,
        at.folders.length ? at.folders.map((f) => row(f, () => browse(f.path), svg(ICON.chevR))) : h('div', { class: 'hint', style: 'padding-bottom:8px' }, 'No folders inside.'),
      ] : h('div', { class: 'working' }, h('span', { class: 'spin' })))
  }

  async function browse(path) {
    try {
      at = await api('GET', `/folders?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`)
    } catch (e) {
      // The chat's folder may be gone: start from the default instead.
      const fallback = places?.defaultFolder?.path
      if (fallback && path !== fallback) return browse(fallback)
      toast(e.message)
    }
    paintList()
  }

  let timer = null
  search.addEventListener('input', () => {
    clearTimeout(timer)
    query = search.value.trim()
    found = null
    paintList()
    if (!query) return
    const q = query
    timer = setTimeout(async () => {
      try {
        const r = await api('GET', `/folders?q=${encodeURIComponent(q)}`)
        if (q === query) { found = r.folders; paintList() }
      } catch (e) { toast(e.message) }
    }, 250)
  })

  paintMachines()
  paintList()
  browse(V.chat.where?.folder || places?.defaultFolder?.path || '~/dev')
}

// ---------- Workers ----------

async function loadWorkers() {
  try {
    S.workers = (await api('GET', '/workers')).workers
    S.workersError = null
  } catch (e) { S.workersError = e.message }
  paintWorkers()
  paintBadges()
}

const STATE = { working: 'Working', needs: 'Needs you', idle: 'Idle', done: 'Done' }

function paintWorkers() {
  const box = $('#workers')
  box.replaceChildren()
  // A failed refresh never leaves an old list on screen: it may show workers that have stopped.
  if (S.workersError) return box.append(h('div', { class: 'note' }, S.workersError))
  if (!S.workers) return box.append(h('div', { class: 'working' }, h('span', { class: 'spin' })))
  if (!S.workers.length) box.append(h('div', { class: 'note' }, 'No workers running. The Assistant\'s own subagents work inside its chat and don\'t show here; ask it for a worker to follow a job here.'))
  S.workers.forEach((w) => box.append(workerRow(w)))
}

function workerRow(w) {
  const working = w.state === 'working'
  return h('button', { class: 'row-item' + (S.panelFor === `w:${w.id}` ? ' on' : ''), onclick: () => openWorker(w, true) },
    h('span', { class: `state-dot st-${w.state}${working ? ' pulse' : ''}` }),
    h('div', { class: 'body' },
      h('div', { class: 'line1' }, h('span', { class: 't' }, w.title), w.at ? h('span', { class: 'ago' }, ago(w.at)) : null),
      w.job ? h('div', { class: 's one' }, w.job) : null,
      // Right now: its latest step while it works (live); otherwise its last report, quietly.
      working
        ? h('div', { class: 'now' }, h('span', { class: 'shimmer' }, `${w.activity || 'Working'}…`))
        : h('div', { class: 'now quiet' }, w.state === 'needs' ? `Needs you · ${w.now}` : w.now)))
}

function openWorker(summary, fromList = false) {
  if (fromList) { S.panelFor = `w:${summary.id}`; paintWorkers() }
  // Wide windows: the worker takes the whole main area over the list; Back, Esc or the browser's back return to it.
  openPage(async (page) => {
    page.classList.add('full-page')
    const body = h('div', { class: 'pagebody' }, h('div', { class: 'working' }, h('span', { class: 'spin' })))
    const sub = h('div', { class: 'sub' }, h('span', { class: `dot st-${summary.state}` }), STATE[summary.state])
    page.append(pageBar(summary.title, sub), body)
    let w
    try { w = await api('GET', `/workers/${encodeURIComponent(summary.id)}`) } catch (e) { body.replaceChildren(h('div', { class: 'error-line' }, e.message)); return }
    sub.replaceChildren(h('span', { class: `dot st-${w.state}` }), STATE[w.state])
    const stop = () => dialog({
      title: `Stop ${w.title}?`, text: "It stops now and won't come back after a restart. Its work so far stays where it is.",
      ok: 'Stop worker', danger: true,
      onOk: async () => {
        try { await api('POST', `/workers/${encodeURIComponent(w.id)}/stop`); toast(`Stopped ${w.title}`); closePage(); loadWorkers() } catch (e) { toast(e.message) }
      },
    })
    put(body,
      w.job ? h('div', { class: 'job' }, w.job) : null,
      h('div', { class: 'meta' }, [w.startedAt && `Started ${timeLabel(w.startedAt)}`, w.machine, w.model].filter(Boolean).join(' · ')),
      h('div', { style: 'height:22px' }),
      w.lines.length ? [...w.lines].reverse().map((l) => h('div', { class: 'report' },
        h('div', { class: 'when' }, `${{ working: 'Working', paused: 'Paused', 'needs-decision': 'Needs you', blocked: 'Blocked', done: 'Done', failed: 'Failed' }[l.state] || l.state} · ${ago(l.at)}`),
        h('div', { class: 'what' }, l.text))) : h('div', { class: 'meta' }, 'No reports yet.'),
      h('div', { style: 'height:10px' }),
      h('button', { class: 'btn danger wide', onclick: stop }, 'Stop worker'),
    )
  }, { fromList })
}

// ---------- Toolbox ----------

async function loadTools() {
  try { S.tools = await api('GET', '/toolbox/items'); S.toolsError = null } catch (e) { S.toolsError = e.message }
  paintToolbox()
  // What mirroring would do (hubs without shared config don't have it: no banner).
  try { S.mirror = S.tools?.installed ? (await api('GET', '/toolbox/mirror')).steps : null } catch { S.mirror = null }
  paintToolbox()
}

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' }

/** Who has an item, for its row and page: both agents, one, and whether the two differ. */
function hasLabel(i) {
  if (i.plugin) return 'plugin · read-only'
  if (i.differs) return 'Claude · Codex · differ'
  if (i.has === 'both') return 'Claude · Codex'
  if (i.notLoaded) return 'Codex · not loaded'
  if (!i.has) return null
  return `${i.has === 'claude' ? 'Claude' : 'Codex'} only`
}

/** Mirror steps that would change something on the page showing, and how many need a choice. */
function mirrorCounts(kind) {
  const steps = (S.mirror || []).filter((x) => (!kind || x.kind === kind))
  return { copy: steps.filter((x) => x.step.action === 'copy').length, choose: steps.filter((x) => x.step.action === 'choose').length }
}

let searchInput
function paintToolbox() {
  const box = $('#toolbox')
  const keep = document.activeElement === searchInput
  box.replaceChildren()
  const all = S.tools || {}
  searchInput ||= h('input', { type: 'search', oninput: (e) => { S.toolQuery[S.toolKind] = e.target.value; paintToolbox() } })
  if (searchInput.value !== S.toolQuery[S.toolKind]) searchInput.value = S.toolQuery[S.toolKind]
  searchInput.placeholder = `Search ${S.toolKind === 'mcp' ? 'MCP servers' : KIND[S.toolKind][1].toLowerCase()}`
  box.append(h('div', { class: 'search' }, svg(ICON.search), searchInput))
  if (keep) searchInput.focus()
  if (S.toolsError) return box.append(h('div', { class: 'note' }, S.toolsError))
  if (!S.tools) return box.append(h('div', { class: 'working' }, h('span', { class: 'spin' })))
  const n = mirrorCounts(S.toolKind)
  if (n.copy || n.choose) {
    const words = [n.copy ? `${n.copy} only in one agent` : '', n.choose ? `${n.choose} differ` : ''].filter(Boolean).join(' · ')
    box.append(h('button', { class: 'row-item mirror-banner', onclick: openMirror },
      h('div', { class: 'body' },
        h('div', { class: 'line1' }, h('span', { class: 't' }, 'Claude Code and Codex differ'), h('span', { class: 'ago' }, svg(ICON.chevR))),
        h('div', { class: 's' }, `${words}. Review and copy across`))))
  }
  const q = S.toolQuery[S.toolKind].toLowerCase()
  const items = (all[S.toolKind] || []).filter((i) => !q || i.name.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))
  if (!items.length) box.append(h('div', { class: 'note' }, 'Nothing here.'))
  for (const i of items) {
    box.append(h('button', { class: 'row-item' + (S.panelFor === `${S.toolKind}:${i.id}` ? ' on' : ''), onclick: () => openTool({ ...i, kind: S.toolKind }, S.toolKind, true) },
      h('div', { class: 'body' },
        h('div', { class: 'line1' }, h('span', { class: 't', style: 'flex:initial' }, i.name),
          hasLabel(i) ? h('span', { class: 'plugin-tag' + (i.differs ? ' warn' : '') }, hasLabel(i)) : null),
        i.description ? h('div', { class: 's', style: '-webkit-line-clamp:1' }, i.description) : null)))
  }
}

/** A skill or agent file split into its description and body (no YAML on screen). */
function splitItem(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!m) return { description: '', body: content.trim() }
  const lines = m[1].split(/\r?\n/)
  let description = ''
  for (let i = 0; i < lines.length; i++) {
    const kv = /^description:\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    let v = kv[1].trim()
    if (/^[|>][-+]?$/.test(v)) {
      const block = []
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) block.push(lines[++i].trim())
      v = block.join(' ').trim()
    }
    description = v.replace(/^["']|["']$/g, '')
  }
  return { description, body: content.slice(m[0].length).trim() }
}

function itemView(kind, content) {
  if (kind === 'mcp') return h('div', { class: 'codebox mono' }, content)
  const p = splitItem(content)
  return [p.description ? h('div', { class: 'desc' }, p.description) : null, h('div', { class: 'md', html: window.md.render(p.body) })]
}

/** View an item, "Change it…" with a chosen model, or edit by hand. Without an item: + New. */
function openTool(item, kind = item?.kind, fromList = false) {
  if (fromList) { S.panelFor = `${kind}:${item.id}`; paintToolbox() } else if (!item) panelClosed()
  // Wide windows: a whole page in the main area over the list, like a worker.
  openPage(async (page) => {
    page.classList.add('full-page')
    const isNew = !item
    let content = null
    let draft = null
    let working = false
    let keys = null // an MCP server's keys: [{ name, set }]
    let inConfig = null // its values still written in a config (shown hidden)
    let codexNote = null
    let model = S.assistant.chat?.model || 'claude:opus'
    let effort = S.assistant.chat?.effort || 'medium'
    const readOnly = !!item?.plugin
    const titleEl = h('h1')
    const subEl = h('div', { class: 'sub' })
    const pencil = h('button', { class: 'hbtn', 'aria-label': 'Edit by hand', onclick: () => handEdit() }, svg(ICON.pencil))
    const body = h('div', { class: 'pagebody' })
    const foot = h('div', { class: 'pagefoot' })
    const bar = h('div', { class: 'pagebar' }, h('button', { class: 'back', 'aria-label': 'Back', onclick: closePage }, svg(ICON.back)),
      h('div', { class: 'titles' }, titleEl, subEl), pencil)
    page.append(bar, body, foot)

    const change = composer({
      hint: isNew ? 'Describe it…' : 'Change it…',
      onSend: async (request) => {
        working = true
        paint()
        try {
          draft = await api('POST', '/toolbox/draft', {
            kind, request, model, effort,
            ...(draft || item ? { id: draft?.id ?? item.id } : {}),
            ...((draft?.content ?? content) ? { current: draft?.content ?? content } : {}),
          })
        } finally { working = false; paint() }
      },
    })
    const paintChip = () => change.setChips([modelChip(model, effort, (m, e) => { model = m; effort = e; paintChip() }, false)])
    paintChip()

    const save = async () => {
      working = true
      paint()
      try {
        const r = await api('POST', '/toolbox/save', { kind, id: isNew ? draft.id : item.id, content: draft.content, isNew })
        toast(r?.note || 'Saved')
        loadTools()
        if (isNew) return closePage()
        content = draft.content
        draft = null
      } catch (e) { toast(e.message) } finally { working = false; paint() }
    }

    function paint() {
      titleEl.textContent = draft?.id ?? item?.name ?? `New ${KIND[kind][0].toLowerCase()}`
      subEl.textContent = draft ? `${KIND[kind][0]} · not saved yet` : [KIND[kind][0], item && hasLabel(item)].filter(Boolean).join(' · ')
      pencil.hidden = isNew || readOnly || content == null
      body.replaceChildren()
      const shown = draft?.content ?? content
      if (shown != null) body.append(...[itemView(kind, shown)].flat().filter(Boolean))
      else if (isNew) body.append(h('div', { class: 'empty' }, `Say what the new ${KIND[kind][0].toLowerCase()} should do, and the model you pick writes it.`))
      else body.append(h('div', { class: 'working' }, h('span', { class: 'spin' })))
      if (!draft && item?.notLoaded) body.append(h('div', { class: 'desc' }, `Codex doesn't load this one: ${item.notLoaded}. Copying it across in the review makes it Codex's own.`))
      if (!draft && codexNote) body.append(h('div', { class: 'desc' }, `Claude Code only: ${codexNote}.`))
      if (!draft && inConfig) body.append(h('div', { class: 'desc' }, `Still written in the config: ${inConfig.join(', ')}. Saving it here moves ${inConfig.length > 1 ? 'them' : 'it'} to the key store.`))
      if (!draft && keys?.length) body.append(...keysCard(keys, () => reload()))
      foot.replaceChildren()
      if (working) foot.append(h('div', { class: 'working' }, h('span', { class: 'spin' }), draft ? 'Working…' : 'Writing it…'))
      else if (draft) foot.append(h('div', { class: 'bar' },
        h('button', { class: 'btn ghost', onclick: () => { draft = null; paint() } }, 'Discard'),
        h('button', { class: 'btn primary', onclick: save }, 'Save')))
      else if (!readOnly && (isNew || content != null)) foot.append(change)
    }

    function handEdit() {
      openPage((p2) => {
        p2.classList.add('full-page')
        const ta = h('textarea', { class: 'handedit', spellcheck: 'false' })
        ta.value = draft?.content ?? content ?? ''
        const doSave = async () => {
          try {
            const r = await api('POST', '/toolbox/save', { kind, id: item.id, content: ta.value })
            content = ta.value
            draft = null
            toast(r?.note || 'Saved')
            loadTools()
            closePage()
            reload()
          } catch (e) { toast(e.message) }
        }
        const del = () => dialog({
          title: `Delete ${item.name}?`, text: S.tools?.installed ? 'It goes from both Claude Code and Codex, into Limeade\'s bin on this computer, so it can be brought back by hand.' : 'It goes to the Toolbox bin on the server, so it can be brought back by hand.', ok: 'Delete', danger: true,
          onOk: async () => {
            try {
              await api('POST', '/toolbox/delete', { kind, id: item.id })
              toast('Deleted')
              loadTools()
              history.go(-2)
            } catch (e) { toast(e.message) }
          },
        })
        p2.append(pageBar(item.name, null,
          h('button', { class: 'hbtn', style: 'color:var(--danger)', 'aria-label': 'Delete', onclick: del }, svg(ICON.trash)),
          h('button', { class: 'linkbtn', style: 'padding:0 10px', onclick: doSave }, 'Save')), ta)
      })
    }

    async function reload() {
      try {
        const r = await api('GET', `/toolbox/item?kind=${kind}&id=${encodeURIComponent(item.id)}`)
        content = r.content
        keys = r.keys || null
        inConfig = r.inConfig?.length ? r.inConfig : null
        codexNote = r.codexCannot || null
      } catch (e) { body.replaceChildren(h('div', { class: 'error-line' }, e.message)); return }
      paint()
    }

    paint()
    if (!isNew) await reload()
  }, { fromList: fromList || !item })
}

/** An MCP server's keys: which are set (never their values), and a way to set or replace one. */
function keysCard(keys, done) {
  return [
    h('div', { class: 'section', style: 'padding-left:6px' }, 'Keys'),
    h('div', { class: 'card', style: 'margin:0 0 8px' },
      keys.map((k) => h('button', { class: 'cardrow', onclick: () => keyDialog(k, done) },
        h('div', { class: 'grow' }, h('div', { class: 'mono', style: 'font-size:14.5px' }, k.name),
          h('div', { class: 'small' }, k.set ? 'Set · kept outside the config' : 'Not set: the server won\'t get it')),
        h('span', { class: 'small', style: 'color:var(--accent2)' }, k.set ? 'Replace' : 'Set')))),
    h('div', { class: 'small', style: 'color:var(--faint);font-size:13.5px;padding:0 6px 10px' }, 'Keys stay in this computer\'s key store. Claude Code and Codex get them when Limeade starts them.'),
  ]
}

function keyDialog(k, done) {
  const root = $('#sheet-root')
  const close = () => root.replaceChildren()
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the key', style: 'width:100%;height:44px;padding:0 12px;border-radius:12px;border:1px solid var(--line2);background:var(--bg);outline:0;margin-top:4px' })
  const save = async (value) => {
    try {
      await api('POST', '/toolbox/key', { name: k.name, value })
      close()
      toast(value ? 'Key saved' : 'Key removed')
      done()
    } catch (e) { toast(e.message) }
  }
  root.replaceChildren(
    h('div', { class: 'scrim', onclick: close }),
    h('div', { class: 'dialog', role: 'dialog' }, h('h3', {}, k.name), h('p', {}, 'Kept in the key store, never in a config file.'), input,
      h('div', { class: 'acts' },
        k.set ? h('button', { class: 'danger', onclick: () => save('') }, 'Remove') : null,
        h('button', { onclick: close }, 'Cancel'),
        h('button', { onclick: () => input.value && save(input.value) }, 'Save'))),
  )
  input.focus()
}

/** What only one agent has gets copied to the other; where the two differ, the user picks which to keep. */
function openMirror() {
  openPage((page) => {
    page.classList.add('full-page')
    const choices = {}
    let working = false
    const body = h('div', { class: 'pagebody', style: 'padding:0 0 28px' })
    const foot = h('div', { class: 'pagefoot' })
    page.append(pageBar('Claude Code and Codex', 'Copy what only one has'), body, foot)
    const arrow = (from) => `${AGENT_NAME[from]} → ${AGENT_NAME[from === 'claude' ? 'codex' : 'claude']}`
    function paint() {
      body.replaceChildren()
      const steps = (S.mirror || []).filter((x) => x.step.action !== 'same')
      if (!steps.length) body.append(h('div', { class: 'empty' }, 'Both agents have the same skills, agents and MCP servers.'))
      for (const kind of ['skill', 'agent', 'mcp']) {
        const mine = steps.filter((x) => x.kind === kind)
        if (!mine.length) continue
        body.append(h('div', { class: 'section' }, KIND[kind][1]), h('div', { class: 'card' }, mine.map((x) => {
          const key = `${x.kind}:${x.id}`
          const keyNote = x.keys?.length ? `${x.keys.join(', ')} goes in the key store for the other agent` : ''
          if (x.step.action === 'copy') {
            return h('div', { class: 'cardrow' }, h('div', { class: 'grow' }, h('div', {}, x.name), h('div', { class: 'small' }, [arrow(x.step.from), keyNote].filter(Boolean).join(' · '))))
          }
          if (x.step.action === 'cannot') {
            return h('div', { class: 'cardrow' }, h('div', { class: 'grow' }, h('div', {}, x.name), h('div', { class: 'small' }, `Stays ${x.has === 'codex' ? 'in Codex' : 'in Claude Code'}: ${x.step.why}`)))
          }
          const pick = (side) => h('button', { class: 'chip' + (choices[key] === side ? ' on' : ''), 'aria-pressed': String(choices[key] === side), onclick: () => { choices[key] = choices[key] === side ? undefined : side; paint() } }, `Keep ${side === 'claude' ? 'Claude' : 'Codex'}'s`)
          return h('div', { class: 'cardrow', style: 'flex-wrap:wrap' },
            h('div', { class: 'grow' }, h('div', {}, x.name), h('div', { class: 'small' }, ['They differ. Pick one or leave both as they are', keyNote].filter(Boolean).join(' · '))),
            h('div', { style: 'display:flex;gap:8px;flex-basis:100%' }, pick('claude'), pick('codex')))
        })))
      }
      const n = steps.filter((x) => x.step.action === 'copy').length + Object.values(choices).filter(Boolean).length
      foot.replaceChildren()
      if (working) foot.append(h('div', { class: 'working' }, h('span', { class: 'spin' }), 'Copying…'))
      else if (n) foot.append(h('div', { class: 'bar' }, h('button', { class: 'btn primary', onclick: apply }, `Copy ${n} across`)))
    }
    async function apply() {
      working = true
      paint()
      try {
        const r = await api('POST', '/toolbox/mirror', { choices })
        toast(r.failed.length ? `${r.done.length} copied, ${r.failed.length} failed: ${r.failed[0].error}` : `${r.done.length} copied`)
        await loadTools()
        for (const k of Object.keys(choices)) delete choices[k]
      } catch (e) { toast(e.message) } finally { working = false; paint() }
    }
    paint()
  })
}

// ---------- Settings ----------

function urlKey(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function openSettings() {
  panelClosed()
  // Wide windows: Settings takes the whole main area, like Assistant or Chat (not the side panel).
  openPage(async (page) => {
    page.classList.add('full-page', 'settings-page')
    const body = h('div', { class: 'pagebody', style: 'padding:0 0 28px' })
    page.append(pageBar('Settings', null), body)
    let push = { supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window, sub: null, kinds: { done: true, needs: true, approval: true } }
    let fleetMode = null
    let fleetFixed = false
    let hubSettings = null
    let agentList = null
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone
    const isApple = /iPhone|iPad|iPod/.test(navigator.userAgent)

    async function readPush() {
      if (!push.supported) return
      const reg = await navigator.serviceWorker.ready
      push.sub = await reg.pushManager.getSubscription()
      if (push.sub) {
        const st = await api('POST', '/push/status', { endpoint: push.sub.endpoint }).catch(() => null)
        if (st?.subscribed) push.kinds = st.kinds
        else push.sub = null // the hub forgot it; offer to turn on again
      }
    }
    async function turnOn() {
      try {
        if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications are blocked for this site')
        const { publicKey } = await api('GET', '/push/key')
        const reg = await navigator.serviceWorker.ready
        const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(publicKey) }))
        const label = `${isApple ? 'Apple' : /Android/.test(navigator.userAgent) ? 'Android' : 'Computer'} ${standalone ? 'app' : 'browser'}`
        await api('POST', '/push/subscribe', { subscription: sub.toJSON(), kinds: push.kinds, label })
        push.sub = sub
        toast('Notifications on')
      } catch (e) { toast(e.message || 'Could not turn notifications on') }
      paint()
    }
    async function turnOff() {
      try { await api('POST', '/push/unsubscribe', { endpoint: push.sub.endpoint }); await push.sub.unsubscribe() } catch {}
      push.sub = null
      paint()
    }
    async function setKind(k, v) {
      push.kinds = { ...push.kinds, [k]: v }
      paint()
      if (push.sub) await api('POST', '/push/subscribe', { subscription: push.sub.toJSON(), kinds: push.kinds, label: '' }).catch((e) => toast(e.message))
    }
    async function test() {
      try {
        const r = await api('POST', '/push/test', { endpoint: push.sub.endpoint })
        toast(r.sent ? 'Sent. It should arrive in a few seconds.' : 'Nothing sent: turn notifications off and on again.')
      } catch (e) { toast(e.message) }
    }

    /** A fresh install's first steps, until they're done or put away. */
    function gettingStarted() {
      if (!hubSettings?.localOnly || !agentList || localStorage.getItem('setupDone')) return null
      const agentReady = agentList.some((v) => v.status.installed && v.status.signedIn)
      const localReady = S.models.some((g) => g.engine === 'local' && g.online && g.models.length)
      const steps = [
        [agentReady, 'Set up Claude Code or Codex', 'Install and sign in, in one tap each', () => openAgentSetup(agentList.find((v) => !v.status.signedIn)?.agent || 'claude')],
        ...(hubSettings.ollamaUrl !== undefined ? [[localReady, 'Connect Ollama', localReady ? 'Local models are ready' : 'For local models; skip if you don\'t use them', () => openLocalModels()]] : []),
        [false, 'Add your MCP servers and keys', 'Optional: tools like Jira or GitHub, shared by both agents', () => { closePage(); setTab('mcp') }],
        [!!push.sub, 'Turn on notifications', 'Worker news and approvals on this device', () => push.supported && !push.sub && turnOn()],
      ]
      return [
        h('div', { class: 'section' }, 'Get started'),
        h('div', { class: 'card' }, steps.map(([done, label, small, go]) =>
          h('button', { class: 'cardrow', onclick: go }, h('span', { class: `dot${done ? ' on' : ''}` }),
            h('span', { class: 'grow' }, h('div', {}, label), h('div', { class: 'small' }, small)), svg(ICON.chevR))),
          h('button', { class: 'cardrow', onclick: () => { localStorage.setItem('setupDone', '1'); paint() } }, h('span', { class: 'grow', style: 'color:var(--muted)' }, 'Hide these steps'))),
        h('div', { class: 'hint' }, 'Your Assistant works once one agent is signed in, or with a local model that uses tools.'),
      ]
    }

    const toggle = (label, on, onChange) => h('button', { class: 'cardrow', onclick: () => onChange(!on) }, h('span', { class: 'grow' }, label), h('span', { class: 'switch' + (on ? ' on' : '') }))

    function paint() {
      const dark = document.documentElement.dataset.theme !== 'light'
      put(body,
        gettingStarted(),
        h('div', { class: 'section' }, 'Notify me when'),
        !push.supported
          ? h('div', { class: 'hint', style: 'padding-top:0' }, isApple && !standalone
            ? 'On iPhone, notifications work once Limeade is on your Home Screen: Share › Add to Home Screen, then open it from there.'
            : "This browser can't show notifications.")
          : h('div', { class: 'card' },
            push.sub ? [
              toggle('Work is done', push.kinds.done, (v) => setKind('done', v)),
              toggle('A worker needs me', push.kinds.needs, (v) => setKind('needs', v)),
              toggle('A command needs approval', push.kinds.approval, (v) => setKind('approval', v)),
              h('button', { class: 'cardrow', onclick: test }, h('span', { class: 'grow linkbtn' }, 'Send a test')),
              h('button', { class: 'cardrow', onclick: turnOff }, h('span', { class: 'grow', style: 'color:var(--muted)' }, 'Turn off on this device')),
            ] : h('button', { class: 'cardrow', onclick: turnOn }, h('span', { class: 'grow' }, h('div', { class: 'linkbtn' }, 'Turn on notifications'), h('div', { class: 'small' }, 'For this device. Approvals can be answered from the notification.')))),
        push.supported && !push.sub && isApple && !standalone ? h('div', { class: 'hint' }, 'On iPhone, add Limeade to your Home Screen first (Share › Add to Home Screen).') : null,
        // Only where there's another assistant to choose (a server with its own fleet scripts).
        fleetFixed ? null : [
          h('div', { class: 'section' }, 'Worker updates go to'),
          fleetMode ? h('div', { class: 'seg2' }, [['claude-app', 'Claude app'], ['app', 'Limeade']].map(([v, label]) =>
            h('button', { class: fleetMode === v ? 'on' : '', onclick: async () => {
              try { await api('PUT', '/fleet-mode', { mode: v }); fleetMode = v; paint() } catch (e) { toast(e.message) }
            } }, label))) : h('div', { class: 'hint', style: 'padding-top:0' }, '…'),
          h('div', { class: 'hint' }, 'One assistant handles worker news at a time.'),
        ],
        h('div', { class: 'section' }, 'Assistant'),
        h('div', { class: 'card' }, h('button', { class: 'cardrow', onclick: async () => {
          try { await api('POST', '/chats/assistant/new-session'); await loadAssistant(); toast('The next message starts a fresh conversation') } catch (e) { toast(e.message) }
        } }, h('span', { class: 'grow' }, 'Start a fresh conversation'))),
        h('div', { class: 'section' }, 'Agents'),
        agentList ? h('div', { class: 'card' }, agentList.map((v) =>
          h('button', { class: 'cardrow', onclick: () => openAgentSetup(v.agent) },
            h('span', { class: `dot${v.status.installed && v.status.signedIn ? ' on' : ''}` }),
            h('span', { class: 'grow' }, h('div', {}, v.name), h('div', { class: 'small' }, agentLine(v))),
            svg(ICON.chevR)))) : h('div', { class: 'hint', style: 'padding-top:0' }, '…'),
        hubSettings?.ollamaUrl !== undefined ? [
          h('div', { class: 'section' }, 'Local models'),
          h('div', { class: 'card' }, h('button', { class: 'cardrow', onclick: () => editOllama(hubSettings.ollamaUrl, (r) => { hubSettings = r; S.hub = r; paint() }) },
            h('span', { class: 'grow' }, h('div', {}, 'Ollama'), h('div', { class: 'small' }, hubSettings.ollamaUrl)), svg(ICON.chevR))),
          h('div', { class: 'hint' }, 'Where Limeade finds Ollama. Add and remove its models on the Local models page.'),
        ] : null,
        h('div', { class: 'section' }, 'Claude'),
        hubSettings ? h('div', { class: 'card' }, toggle('Run Claude through ACP', hubSettings.claudeAcp, async (v) => {
          try { hubSettings = await api('PUT', '/settings', { claudeAcp: v }); paint() } catch (e) { toast(e.message) }
        })) : h('div', { class: 'hint', style: 'padding-top:0' }, '…'),
        h('div', { class: 'hint' }, 'Preview. The next message in any chat uses it; chats and their history stay the same either way.'),
        h('div', { class: 'section' }, 'Look'),
        h('div', { class: 'card' }, toggle('Dark theme', dark, (v) => {
          document.documentElement.dataset.theme = v ? 'dark' : 'light'
          localStorage.setItem('theme', v ? 'dark' : 'light')
          document.querySelector('meta[name=theme-color]').content = v ? '#0C1326' : '#FFFFFF'
          paint()
        })),
        h('div', { class: 'section' }, 'Hub'),
        h('div', { class: 'card' }, h('div', { class: 'cardrow' }, h('span', { class: `dot${S.connected ? ' on' : ''}` }),
          h('span', { class: 'grow' }, h('div', {}, hubName()), h('div', { class: 'small' }, `${S.connected ? 'Online' : 'Offline'} · ${location.host}`))),
          hubSettings?.localOnly ? h('button', { class: 'cardrow', onclick: phoneHowTo },
            h('span', { class: 'grow' }, h('div', {}, 'Use it from your phone'), h('div', { class: 'small' }, 'Optional, with Tailscale')), svg(ICON.chevR)) : null),
      )
    }
    paint()
    await Promise.all([
      readPush().catch(() => {}),
      api('GET', '/fleet-mode').then((r) => { fleetMode = r.mode; fleetFixed = !!r.fixed }).catch(() => {}),
      api('GET', '/settings').then((r) => { hubSettings = r; S.hub = r }).catch(() => {}),
      api('GET', '/agents').then((r) => { agentList = r.agents }).catch(() => {}),
    ])
    paint()
    // Back from an agent's page (or an install finishing): its line here follows.
    watchAgents(page, async () => { agentList = (await api('GET', '/agents').catch(() => null))?.agents ?? agentList; paint() })
  }, { fromList: true })
}

/** Settings › Local models: where Ollama is (this computer's by default). */
function editOllama(current, done) {
  const input = h('input', { value: current, maxlength: 300, inputmode: 'url', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Ollama address' })
  const save = async () => {
    try {
      done(await api('PUT', '/settings', { ollamaUrl: input.value }))
      el.close()
      toast('Saved. Models show in a few seconds.')
      setTimeout(loadModels, 3000)
    } catch (e) { toast(e.message) }
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save())
  const el = sheet('Ollama address', 'Usually http://localhost:11434 (Ollama on this computer). Another computer\'s works too, if Ollama there listens on the network.',
    h('div', { class: 'field', style: 'margin:6px 16px 12px' }, input),
    h('div', { style: 'padding:0 16px' }, h('button', { class: 'btn primary wide', onclick: save }, 'Save')))
  input.focus()
}

/** Settings › Hub: reaching Limeade on this computer from a phone. Not built in: Tailscale does it. */
function phoneHowTo() {
  const port = location.port || '80'
  const step = (n, text, code) => h('div', { style: 'display:flex;gap:10px;padding:8px 16px' }, h('b', {}, `${n}.`),
    h('div', {}, text, code ? h('div', { style: 'margin-top:6px' }, h('code', {}, code)) : null))
  sheet('Use it from your phone', 'Limeade only listens on this computer. Tailscale gives your phone a private, encrypted way in.',
    step(1, 'Install Tailscale on this computer and your phone, and sign in to both with the same account.'),
    step(2, 'On this computer, in Terminal:', `tailscale serve --bg ${port}`),
    step(3, 'It prints an address like https://my-mac.tail1234.ts.net. Let Limeade answer to that name:', 'limeade phone my-mac.tail1234.ts.net'),
    step(4, 'On your phone, open that address and add it to the Home Screen. Turn on notifications there too.'),
    h('div', { class: 'hint' }, 'Anyone on your Tailscale network can open it, so keep that network to your own devices.'))
}

// ---------- Settings › Agents: install, sign in, API key ----------

const agentWatchers = new Set() // refreshers of the open Settings and agent pages
/** Runs `refresh` on every agent change while `page` is open. */
function watchAgents(page, refresh) {
  agentWatchers.add(refresh)
  new MutationObserver((_, obs) => { if (!page.isConnected) { agentWatchers.delete(refresh); obs.disconnect() } }).observe($('#pages'), { childList: true })
}
function onAgentsEvent() {
  loadModels() // the picker's notes
  for (const refresh of agentWatchers) refresh()
}

const SIGN_IN_HOW = { subscription: 'Claude subscription', console: 'Anthropic Console', 'api-key': 'API key', chatgpt: 'ChatGPT' }

/** One line about an agent: installing, not installed, or its version and how it's signed in. */
function agentLine(v) {
  const st = v.status
  if (v.install?.running) return `Installing ${v.install.version}…`
  if (!st.installed) return 'Not installed'
  const ver = st.version ? `${st.version} · ` : ''
  if (!st.signedIn) return `${ver}Not signed in`
  return `${ver}${SIGN_IN_HOW[st.how] || 'Signed in'}${st.account ? ` · ${st.account}` : ''}`
}

function openAgentSetup(agentId) {
  openPage((page) => {
    // Wide windows: a whole page over Settings (back returns to it), not a panel half over it.
    page.classList.add('full-page', 'settings-page')
    const sub = h('div', { class: 'sub' })
    const body = h('div', { class: 'pagebody', style: 'padding:0 0 28px' })
    page.append(pageBar(AGENT_NAMES[agentId], sub), body)
    let v = null
    let busy = false
    let error = null
    let code = ''
    let key = ''

    async function act(fn) {
      if (busy) return
      busy = true
      error = null
      paint()
      try { v = await fn() } catch (e) { error = e.message }
      busy = false
      paint()
    }
    const post = (path, b, m = 'POST') => () => api(m, `/agents/${agentId}${path}`, b)
    const row = (...kids) => h('div', { class: 'cardrow' }, ...kids)
    const textRow = (title, small) => row(h('span', { class: 'grow' }, h('div', {}, title), small ? h('div', { class: 'small' }, small) : null))
    const actionRow = (title, small, onclick, disabled) => h('button', { class: 'cardrow', onclick, disabled: disabled || busy },
      h('span', { class: 'grow' }, h('div', { class: 'linkbtn' }, title), small ? h('div', { class: 'small' }, small) : null))

    function installCard() {
      const st = v.status
      const run = v.install
      const rows = []
      if (st.installed) rows.push(textRow(`Version ${st.version || 'unknown'}`, null))
      if (run?.running) rows.push(row(h('span', { class: 'spin' }), h('span', { class: 'grow' }, h('div', {}, `Installing ${run.version}…`), h('div', { class: 'small' }, 'This takes a minute or two.'))))
      else if (!st.installed) rows.push(actionRow(`Install ${v.name} ${v.pinned}`, 'Into your own folder, no admin password. Telemetry and update checks off.', () => act(post('/install'))))
      else if (v.update) rows.push(actionRow(`Update to ${v.update}`, null, () => act(post('/install'))))
      return [
        h('div', { class: 'section' }, 'Install'),
        h('div', { class: 'card' }, rows),
        run?.error && !run.running ? h('div', { class: 'hint', style: 'color:var(--danger)' }, "The install didn't finish. Check the internet connection and try again.") : null,
        st.installed && !st.managed ? h('div', { class: 'hint' }, 'Installed outside Limeade, so it updates the way you installed it.') : null,
      ]
    }

    function flowRows(run) {
      if (run.state === 'checking') return [row(h('span', { class: 'spin' }), h('span', { class: 'grow' }, 'Checking the code…'))]
      if (run.state === 'done') return [textRow('Signed in', null)]
      if (run.state === 'failed') return [textRow("That didn't work", run.error)]
      const link = run.link
      if (!link) return [row(h('span', { class: 'spin' }), h('span', { class: 'grow' }, 'Getting the sign-in link…'))]
      const rows = [h('a', { class: 'cardrow', href: link.url, target: '_blank', rel: 'noopener noreferrer' },
        h('span', { class: 'grow' }, h('div', { class: 'linkbtn' }, '1. Open the sign-in page'), h('div', { class: 'small' }, new URL(link.url).host)))]
      if (link.userCode) {
        rows.push(row(h('span', { class: 'grow' }, h('div', { class: 'small' }, '2. Enter this code there'), h('div', { class: 'mono agent-code' }, link.userCode)),
          h('button', { class: 'iconbtn', 'aria-label': 'Copy code', onclick: () => navigator.clipboard?.writeText(link.userCode).then(() => toast('Copied')) }, svg(ICON.copy))))
        rows.push(row(h('span', { class: 'spin' }), h('span', { class: 'grow small' }, 'Waiting for you to finish there…')))
      }
      if (link.wantsCode) {
        const input = h('input', { type: 'text', placeholder: 'Paste the code here', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: code,
          oninput: (e) => { code = e.target.value } })
        rows.push(h('div', { class: 'cardrow agent-form' }, h('div', { class: 'small' }, '2. Sign in, then paste the code the page shows'),
          h('div', { class: 'agent-input' }, input, h('button', { class: 'btn primary', disabled: busy, onclick: () => { const c = code; code = ''; act(post('/sign-in/code', { code: c })) } }, 'Send'))))
      }
      return rows
    }

    function signInCard() {
      const st = v.status
      const run = v.signIn
      const ways = agentId === 'claude'
        ? [['subscription', 'Sign in with your Claude subscription', 'Pro or Max, through claude.ai'], ['console', 'Sign in with an Anthropic Console account', 'Billed by usage, for work accounts']]
        : [['chatgpt', 'Sign in with ChatGPT', 'Your ChatGPT plan, with a one-time code']]
      const active = run && run.state !== 'done'
      return [
        h('div', { class: 'section' }, 'Sign in'),
        h('div', { class: 'card' },
          textRow(st.signedIn ? `Signed in with ${SIGN_IN_HOW[st.how] || 'an account'}` : 'Not signed in', st.signedIn ? st.account : st.installed ? null : `Install ${v.name} first.`),
          active ? flowRows(run) : ways.map(([how, title, small]) => actionRow(title, small, () => act(post('/sign-in', { how })), !st.installed)),
          active ? actionRow(run.state === 'failed' ? 'Start again' : 'Cancel', null, () => act(post('/sign-in', undefined, 'DELETE'))) : null),
        h('div', { class: 'hint' }, `The sign-in is ${v.name}'s own and stays where ${v.name} keeps it. Limeade never sees or copies it.`),
      ]
    }

    function keyCard() {
      const placeholder = agentId === 'claude' ? 'sk-ant-…' : 'sk-…'
      const input = h('input', { type: 'password', placeholder, autocomplete: 'off', value: key, oninput: (e) => { key = e.target.value } })
      return [
        h('div', { class: 'section' }, 'API key'),
        h('div', { class: 'card' }, v.keySaved
          ? [textRow('API key saved', 'Used instead of the sign-in above.'), actionRow('Remove the key', null, () => act(post('/key', undefined, 'DELETE')))]
          : h('div', { class: 'cardrow agent-form' }, h('div', { class: 'small' }, agentId === 'claude' ? 'An Anthropic API key, e.g. from work' : 'An OpenAI API key, e.g. from work'),
            h('div', { class: 'agent-input' }, input, h('button', { class: 'btn primary', disabled: busy, onclick: () => { const k = key; key = ''; act(post('/key', { key: k }, 'PUT')) } }, 'Save')))),
        h('div', { class: 'hint' }, `Kept by Limeade (in the Keychain on a Mac), never in a config file. ${v.name} gets it each time it starts.`),
      ]
    }

    function paint() {
      if (!v) { put(body, error ? h('div', { class: 'hint', style: 'color:var(--danger)' }, error) : h('div', { class: 'working' }, h('span', { class: 'spin' }))); return }
      sub.textContent = agentLine(v)
      // Keep what's being typed (and the caret) across a repaint.
      const focused = document.activeElement && body.contains(document.activeElement) ? document.activeElement.type : null
      put(body,
        error ? h('div', { class: 'hint', style: 'color:var(--danger)' }, error) : null,
        installCard(), signInCard(), keyCard())
      if (focused) body.querySelector(`input[type=${focused}]`)?.focus()
    }
    const refresh = async () => { try { v = await api('GET', `/agents/${agentId}`) } catch (e) { error = e.message } paint() }
    watchAgents(page, refresh)
    paint()
    refresh()
  })
}

// ---------- tabs and top bar ----------

function setTab(tab) {
  if (tab === 'toolbox') tab = 'skill' // old links to the single Toolbox page
  if (!['assistant', 'chat', 'workers', ...Object.keys(KIND)].includes(tab)) tab = 'assistant'
  if (wide.matches && tab !== S.tab) closeAllPages()
  // Leaving the Assistant while it was on screen: whatever arrived there has been seen.
  if (S.tab === 'assistant' && tab !== 'assistant' && document.visibilityState === 'visible') markSeen()
  S.tab = tab
  const isTool = tab in KIND // MCP, Skills and Agents share one view, showing one kind each
  if (isTool) S.toolKind = tab
  for (const b of document.querySelectorAll('#drawer [data-tab]')) b.classList.toggle('on', b.dataset.tab === tab)
  if (tab === 'chat') sideOpenOnChat = false // Chat has its own list column: fold the sidebar
  paintSide()
  $('#title').textContent = isTool ? KIND[tab][1] : { assistant: 'Assistant', chat: 'Chat', workers: 'Workers' }[tab]
  for (const v of ['assistant', 'chat', 'workers']) $(`#view-${v}`).hidden = v !== tab
  $('#view-toolbox').hidden = !isTool
  const actions = $('#top-actions')
  actions.replaceChildren()
  if (isTool) actions.append(h('button', { class: 'hbtn accent', 'aria-label': 'New', onclick: () => openTool(null, S.toolKind) }, svg(ICON.plus)))
  if (tab === 'chat') actions.append(h('button', { class: 'hbtn accent', 'aria-label': 'New chat', onclick: newChat }, svg(ICON.plus)))
  if (tab === 'assistant') actions.append(h('button', { class: 'bell', 'aria-label': 'Needs you', onclick: openBell }, svg(ICON.bell), h('b', { class: 'badge', id: 'bell-count', hidden: true })))
  if (tab === 'assistant') { markSeen(); S.assistant.end.toEnd() }
  if (tab === 'workers') loadWorkers()
  if (tab === 'chat') { paintChats(); loadChats(); if (!S.places) loadPlaces().then(paintChats) }
  if (isTool) { if (S.tools) paintToolbox(); else loadTools() }
  paintBadges()
}

// ---------- the bell: things that need the user ----------

async function loadInbox() {
  try { setInbox((await api('GET', '/inbox')).items) } catch {}
}

let bellSheet = null
function openBell() {
  bellSheet = sheet('Needs you', null, h('div', { id: 'bell-list' }))
  paintBellSheet()
}

const KIND_WORD = { approval: 'Approval', question: 'Question', look: 'Take a look' }

function paintBellSheet() {
  const list = document.getElementById('bell-list')
  if (!list) return
  put(list, S.inbox.length ? [...S.inbox].reverse().map(bellRow) : h('div', { class: 'note', style: 'padding:6px 20px 16px' }, 'Nothing needs you right now.'))
}

function bellRow(item) {
  const row = h('div', { class: 'bell-row' },
    h('button', { class: 'bell-main', onclick: () => { bellSheet?.close(); openItem(item) } },
      h('div', { class: 'bell-kind' }, `${KIND_WORD[item.kind]} · ${ago(item.at)}`),
      h('div', { class: 'bell-title' }, item.title),
      item.body && item.body !== item.title ? h('div', { class: 'bell-body' }, item.body) : null),
    item.kind === 'approval' ? null : h('button', { class: 'bell-x', 'aria-label': 'Dismiss', onclick: () => dismissItem(item) }, svg(ICON.close)))
  // Swipe sideways to dismiss (not approvals: those need an answer).
  if (item.kind !== 'approval') {
    let x0 = null
    let dx = 0
    row.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; dx = 0 }, { passive: true })
    row.addEventListener('touchmove', (e) => { if (x0 == null) return; dx = e.touches[0].clientX - x0; row.style.transform = `translateX(${dx}px)`; row.style.opacity = String(1 - Math.min(Math.abs(dx) / 240, .7)) }, { passive: true })
    row.addEventListener('touchend', () => { if (Math.abs(dx) > 90) dismissItem(item); else { row.style.transform = ''; row.style.opacity = '' } x0 = null })
  }
  return row
}

async function dismissItem(item) {
  closeNotifications(item)
  S.inbox = S.inbox.filter((i) => i.id !== item.id)
  paintBellSheet()
  paintBadges()
  try { await api('DELETE', `/inbox/${item.id}`) } catch (e) { toast(e.message); loadInbox() }
}

/**
 * Recent and on screen: scroll to it and light it up briefly. Old (or no longer loaded): the assistant
 * asks it again at the bottom with context, so the user can answer right there.
 */
async function openItem(item) {
  setTab('assistant')
  closeNotifications(item)
  const box = $('#thread')
  const selector = item.kind === 'approval' ? `[data-approval="${item.approvalId}"]` : `[data-id="${item.messageId}"]`
  const el = box.querySelector(selector)
  const recent = Date.now() - new Date(item.at).getTime() < 12 * 3600 * 1000
  if (el && (recent || item.kind === 'approval')) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
    // Seen: out of the bell. An approval stays until it's answered Yes or No.
    if (item.kind !== 'approval') dismissItem(item)
    return
  }
  if (item.kind === 'approval') return toast('That approval has expired')
  // Not tied to a message (e.g. a test): seeing it is enough.
  if (!item.messageId) { dismissItem(item); return toast(item.body || item.title) }
  // Old or not in the thread any more: the assistant asks it again (the hub takes it out of the bell).
  S.inbox = S.inbox.filter((i) => i.id !== item.id)
  paintBadges()
  paintBellSheet()
  try {
    await api('POST', `/inbox/${item.id}/reask`)
    toast('Asking it again…')
  } catch (e) { toast(e.message); loadInbox() }
}

/** Takes the item off the phone's one Limeade notification too (keys: inbox-<id>, approval-<approvalId>). */
function closeNotifications(item) {
  clearNotice({ keys: [`inbox-${item.id}`, item.approvalId ? `approval-${item.approvalId}` : null].filter(Boolean) })
}

/** Asks the service worker (it owns the notification) to drop some items, or all of them. */
async function clearNotice(what) {
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.ready
    reg.active?.postMessage({ type: 'clear-notice', ...what })
  } catch {}
}

/** The bell changed on the hub: anything that left it (answered, dismissed elsewhere) leaves the phone too. */
function setInbox(items) {
  const now = new Set(items.map((i) => i.id))
  for (const old of S.inbox) if (!now.has(old.id)) closeNotifications(old)
  // The bell just emptied: nothing on the phone needs him either.
  if (S.inbox.length && !items.length) clearNotice({ all: true })
  S.inbox = items
  paintBadges()
  paintBellSheet()
  markSeenOnScreen()
}

/** The user is looking at the chat right now (visible, Assistant page, nothing pushed over it). */
function lookingAtChat() {
  return onScreen.assistantInFront({
    visible: document.visibilityState === 'visible', tab: S.tab, wide: wide.matches, drawerOpen: !$('#drawer-root').hidden,
    pages: pageStack.map((p) => ({ full: p.classList.contains('full-page') })),
  })
}

/** The chat in front of the user right now: 'assistant', a Chat page chat (its page on top), or null. */
function chatInFront() {
  if (lookingAtChat()) return 'assistant'
  const V = openChatView()
  const onTop = V && pageStack[pageStack.length - 1]?.contains(V.box)
  return onTop && document.visibilityState === 'visible' && ($('#drawer-root').hidden || wide.matches) ? V.id : null
}

/**
 * Tells the hub while this device shows the chat (every 20 s; it forgets after 45 s), so it doesn't buzz
 * this phone for Assistant replies, questions or approvals. Says so at once when he leaves or hides it.
 */
let watchSent = { on: false, at: 0 }
async function syncWatching() {
  const chatId = document.querySelector('#sheet-root > *') ? null : chatInFront()
  // On a computer the window must also have focus: Limeade left open behind other apps doesn't count.
  const on = !!chatId && document.hasFocus()
  if (on === watchSent.on && chatId === watchSent.chatId && (!on || Date.now() - watchSent.at < 20000)) return
  // Just came to the Assistant: the replies on the phone's notification are on screen now (bell items stay).
  if (chatId === 'assistant' && watchSent.chatId !== 'assistant') clearNotice({ replies: true })
  watchSent = { on, chatId, at: Date.now() }
  try {
    if (!('serviceWorker' in navigator)) return
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    if (!sub) return
    await fetch('/push/watching', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, watching: on, ...(chatId ? { chatId } : {}) }),
    })
  } catch { watchSent.at = 0 } // try again on the next tick
}
setInterval(syncWatching, 2000)
addEventListener('pagehide', syncWatching)
addEventListener('focus', syncWatching)
addEventListener('blur', syncWatching)

/** A question or "take a look" whose message is on screen while he's looking: already seen. */
function markSeenOnScreen() {
  if (!lookingAtChat()) return
  const box = $('#thread')
  const view = box.getBoundingClientRect()
  for (const item of S.inbox) {
    if (item.kind === 'approval' || !item.messageId) continue
    const el = box.querySelector(`[data-id="${item.messageId}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.bottom > view.top && r.top < view.bottom) dismissItem(item)
  }
}

// A tap on a notification while Limeade is already open: the service worker hands us the item.
navigator.serviceWorker?.addEventListener('message', (e) => {
  // The service worker asks before showing a phone notification: is the chat in front of him?
  // Same as syncWatching: a window behind other apps doesn't count.
  if (e.data?.type === 'looking-at-chat?') { e.ports[0]?.postMessage(chatInFront() === (e.data.chatId || 'assistant') && !document.querySelector('#sheet-root > *') && document.hasFocus()); return }
  // A tap on a chat's reply notification: open that chat.
  if (e.data?.type === 'open-chat') { setTab('chat'); openChat(e.data.chatId, true); return }
  // A push that arrived while the chat was in front of him: no phone notification; the thread already has it.
  if (e.data?.type === 'push-inline') { loadInbox(); return }
  // A tap on the notification that stood for several items: show them all.
  if (e.data?.type === 'open-bell') { setTab('assistant'); loadInbox().then(openBell); return }
  if (e.data?.type !== 'open-item') return
  const item = S.inbox.find((i) => i.id === e.data.itemId)
  if (item) openItem(item)
  else loadInbox().then(() => { const again = S.inbox.find((i) => i.id === e.data.itemId); again ? openItem(again) : toast('That one is already done') })
})

// ---------- the left drawer (Claude-app style) ----------

const drawerRoot = $('#drawer-root')
const drawer = $('#drawer')
function openDrawer() {
  drawerRoot.hidden = false
  drawer.style.transform = ''
  $('#menu').setAttribute('aria-expanded', 'true')
  history.pushState({ drawer: true }, '')
}
/** Closes it; `then` runs after the history step so a following page push isn't undone. */
function closeDrawer(then) {
  if (drawerRoot.hidden) return then?.()
  drawerRoot.hidden = true
  $('#menu').setAttribute('aria-expanded', 'false')
  if (history.state?.drawer) {
    drawerClosing = true
    if (then) window.addEventListener('popstate', () => setTimeout(then), { once: true })
    history.back()
  } else then?.()
}
$('#menu').addEventListener('click', openDrawer)
$('#drawer-scrim').addEventListener('click', () => closeDrawer())
for (const b of document.querySelectorAll('#drawer [data-tab]')) b.addEventListener('click', () => {
  if (wide.matches && $('#pages > .page.full-page')) closeAllPages() // leaving Settings, a worker or an item, even for the same tab
  setTab(b.dataset.tab)
  closeDrawer()
})
/** Wide: a sidebar page (Settings, Local models) replaces whatever page is open, so only it is lit. */
function openFromSide(open) {
  if (!wide.matches || !pageStack.length) return closeDrawer(open)
  addEventListener('popstate', () => setTimeout(open), { once: true })
  closeAllPages()
}
$('#drawer-settings').addEventListener('click', () => openFromSide(openSettings))
$('#drawer-models').addEventListener('click', () => { if (!$('#pages > .page.models-page')) openFromSide(openLocalModels) })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawerRoot.hidden) closeDrawer() })

// Wide windows: the sidebar folds to an icon rail. The choice is kept on this device; the Chat page
// always opens folded (the toggle still unfolds it there, just for that visit).
let sideOpenOnChat = false
const sideFolded = () => (S.tab === 'chat' ? !sideOpenOnChat : localStorage.getItem('sidebar') === 'slim')
function paintSide() {
  const slim = sideFolded()
  document.body.classList.toggle('side-slim', slim)
  const t = $('#side-toggle')
  const label = `${slim ? 'Expand' : 'Collapse'} sidebar (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}B)`
  t.setAttribute('aria-expanded', String(!slim))
  t.setAttribute('aria-label', label.replace(/ \(.*/, ''))
  t.title = label
}
function toggleSide() {
  if (S.tab === 'chat') sideOpenOnChat = !sideOpenOnChat
  else localStorage.setItem('sidebar', sideFolded() ? 'full' : 'slim')
  paintSide()
  paintListWidth()
}
$('#side-toggle').addEventListener('click', toggleSide)
document.addEventListener('keydown', (e) => {
  if (wide.matches && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSide() }
})
// Wide windows, a chat open: the list beside it is as wide as the user last dragged it on this device.
// The handle on the chat's left edge drags it, arrow keys step it, a double-click puts it back.
const sideWidth = () => parseFloat(getComputedStyle(document.body).getPropertyValue('--side')) || 0 // the target, not mid-fold
let listWant = listWidth.parse(localStorage.getItem('chatListWidth'))
function paintListWidth() {
  const w = listWidth.fit(listWant, innerWidth, sideWidth())
  document.body.style.setProperty('--list', `${w}px`)
  for (const r of document.querySelectorAll('.list-resizer')) {
    r.setAttribute('aria-valuenow', String(w))
    r.setAttribute('aria-valuemax', String(listWidth.maxFor(innerWidth, sideWidth())))
  }
}
function setListWidth(want, keep = true) {
  listWant = listWidth.fit(want, innerWidth, sideWidth())
  if (keep) localStorage.setItem('chatListWidth', String(listWant))
  paintListWidth()
}
function listResizer() {
  const r = h('div', { class: 'list-resizer', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Resize chat list', 'aria-valuemin': String(listWidth.MIN), title: 'Drag to resize, double-click to reset' })
  r.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    r.setPointerCapture(e.pointerId)
    document.body.classList.add('list-resizing')
    const move = (ev) => setListWidth(ev.clientX - sideWidth(), false)
    const end = () => {
      r.removeEventListener('pointermove', move)
      document.body.classList.remove('list-resizing')
      setListWidth(listWant)
    }
    r.addEventListener('pointermove', move)
    r.addEventListener('pointerup', end, { once: true })
    r.addEventListener('pointercancel', end, { once: true })
  })
  r.addEventListener('dblclick', () => { localStorage.removeItem('chatListWidth'); listWant = listWidth.DEFAULT; paintListWidth() })
  r.addEventListener('keydown', (e) => {
    const want = listWidth.afterKey(listWant, e.key, e.shiftKey)
    if (want === null) return
    e.preventDefault()
    setListWidth(want)
  })
  queueMicrotask(paintListWidth)
  return r
}
addEventListener('resize', paintListWidth)
// Folded, each icon says what it is.
for (const b of document.querySelectorAll('#drawer [data-tab], #drawer-settings, #drawer-models')) b.title = b.querySelector('span').textContent
// Swipe left to close: the drawer follows the finger, then snaps shut or back.
let swipe = null
drawer.addEventListener('touchstart', (e) => { swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0 } }, { passive: true })
drawer.addEventListener('touchmove', (e) => {
  if (!swipe) return
  swipe.dx = Math.min(0, e.touches[0].clientX - swipe.x)
  if (Math.abs(e.touches[0].clientY - swipe.y) > Math.abs(swipe.dx) && !swipe.moving) return
  swipe.moving = true
  drawer.style.transition = 'none'
  drawer.style.transform = `translateX(${swipe.dx}px)`
}, { passive: true })
drawer.addEventListener('touchend', () => {
  if (!swipe) return
  drawer.style.transition = ''
  if (swipe.dx < -60) closeDrawer()
  drawer.style.transform = ''
  swipe = null
})

// Opened from a notification (sw.js navigates to /?open=assistant) or fresh.
const startItem = new URLSearchParams(location.search).get('item')
const startBell = new URLSearchParams(location.search).has('bell')
const startChat = new URLSearchParams(location.search).get('chat')
setTab(startChat ? 'chat' : new URLSearchParams(location.search).get('tab') || 'assistant')
if (startChat) { history.replaceState(null, '', '/'); openChat(startChat, true) }
loadAssistant().then(() => loadInbox()).then(() => {
  if (startBell) { history.replaceState(null, '', '/'); return openBell() }
  if (!startItem) return
  history.replaceState(null, '', '/')
  const item = S.inbox.find((i) => i.id === startItem)
  if (item) openItem(item)
  else toast('That one is already done')
})
loadWorkers()
// Friendly model names arrive with the list: repaint what shows them.
loadModels()
connect()
