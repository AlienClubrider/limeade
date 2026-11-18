import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const md = createRequire(import.meta.url)('../public/md.js')

test('markdown renders the usual things and escapes HTML', () => {
  assert.equal(md.render('Hi <script>alert(1)</script>'), '<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>')
  assert.equal(md.render('**TL;DR:** done'), '<p><strong>TL;DR:</strong> done</p>')
  assert.equal(md.render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(md.render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>')
  assert.equal(md.render('## Order'), '<h2>Order</h2>')
  assert.equal(md.render('```\nx < y\n```'), '<pre><code>x &lt; y</code></pre>')
  assert.equal(md.render('see `a<b`'), '<p>see <code>a&lt;b</code></p>')
  assert.match(md.render('[site](https://x.com/a?b=1&c=2)'), /<a href="https:\/\/x.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener">site<\/a>/)
  assert.equal(md.render('[bad](javascript:alert)'), '<p>bad <code>javascript:alert</code></p>')
  assert.match(md.render('go to https://preview-48.example.com. ok'), /href="https:\/\/preview-48.example.com"/)
  assert.match(md.render('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.equal(md.plain('**Bold** [x](https://y)'), 'Bold x')
})

test('a link to a file the agent made opens through the hub and shows its path (issue #9)', () => {
  // What the Assistant said: the link text must not end up as bare words with nowhere to go.
  assert.equal(md.render('Here’s the diagram: [Open Purger diagram](/Users/me/dev/purger/diagram.html)'),
    '<p>Here’s the diagram: <a href="/files/Users/me/dev/purger/diagram.html" target="_blank" rel="noopener">Open Purger diagram</a> <code>/Users/me/dev/purger/diagram.html</code></p>')
  assert.match(md.render('[d](~/x/my%20d.html)'), /href="\/files\/~\/x\/my%20d.html".*<code>~\/x\/my d.html<\/code>/)
  assert.match(md.render('[d](file:///Users/me/a%20b.html)'), /href="\/files\/Users\/me\/a%20b.html".*<code>\/Users\/me\/a b.html<\/code>/)
  // Underscores and stars in a path stay as they are, not italics.
  assert.equal(md.render('[d](/x/_a_/b_c.html) _it_'), '<p><a href="/files/x/%5Fa%5F/b%5Fc.html" target="_blank" rel="noopener">d</a> <code>/x/_a_/b_c.html</code> <em>it</em></p>')
  assert.match(md.render('[x](/a"b<c.html)'), /href="\/files\/a%22b%3Cc.html".*<code>\/a&quot;b&lt;c.html<\/code>/)
  // Somewhere this app can't open still shows where it pointed.
  assert.equal(md.render('[Open diagram](diagram.html)'), '<p>Open diagram <code>diagram.html</code></p>')
  assert.equal(md.plain('[Open diagram](/a/d.html)'), 'Open diagram')
})
