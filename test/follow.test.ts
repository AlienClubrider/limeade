import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { follow } = createRequire(import.meta.url)('../public/follow.js')

/** A thread box: 1000 px of content in a 400 px window, at its end. */
function thread() {
  let t = 0
  const box = Object.assign(new EventTarget(), { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })
  const win = new EventTarget()
  const end = follow(box, { now: () => t, win })
  const fire = (on: EventTarget, name: string) => on.dispatchEvent(new Event(name))
  const scrollTo = (top: number) => { box.scrollTop = top; fire(box, 'scroll') }
  return { box, win, end, fire, scrollTo, later: (ms: number) => { t += ms } }
}

test('thread end: a photo loading above him keeps him at the end', () => {
  const { box, end, fire } = thread()
  box.scrollHeight = 1800 // the photo took its size
  fire(box, 'load')
  assert.equal(box.scrollTop, 1800)
  assert.ok(end.stuck)
})

test('thread end: the thread moving under him (no finger, wheel or key) never lets go of the end', () => {
  const { box, end, scrollTo } = thread()
  box.scrollHeight = 1800
  scrollTo(200) // e.g. the browser keeping something else in view
  assert.ok(end.stuck)
  assert.equal(box.scrollTop, 1800)
})

test('thread end: his own scroll up lets go, and new text no longer pulls him down', () => {
  const { box, end, fire, scrollTo, later } = thread()
  fire(box, 'touchstart')
  scrollTo(300)
  fire(box, 'touchend')
  assert.equal(end.stuck, false)
  later(5000)
  box.scrollHeight = 1400
  end.keep()
  assert.equal(box.scrollTop, 300)
})

test('thread end: a flick keeps counting as his for a moment after the finger lifts', () => {
  const { box, win, end, fire, scrollTo, later } = thread()
  fire(box, 'touchstart')
  fire(win, 'touchend')
  later(300)
  scrollTo(100)
  assert.equal(end.stuck, false)
})

test('thread end: scrolling back down to the end follows again; sending always goes to the end', () => {
  const { box, end, fire, scrollTo, later } = thread()
  fire(box, 'wheel')
  scrollTo(100)
  assert.equal(end.stuck, false)
  later(2000)
  end.toEnd()
  assert.ok(end.stuck)
  assert.equal(box.scrollTop, 1000)
  fire(box, 'wheel')
  scrollTo(100)
  scrollTo(590) // within reach of the end
  assert.ok(end.stuck)
})

test('thread end: typing in the composer is not scrolling', () => {
  const { box, win, end, later } = thread()
  later(5000)
  const typed = Object.assign(new Event('keydown'), {})
  Object.defineProperty(typed, 'target', { value: { closest: () => ({}) } })
  win.dispatchEvent(typed)
  box.scrollHeight = 1500
  box.scrollTop = 200
  box.dispatchEvent(new Event('scroll'))
  assert.ok(end.stuck)
})
