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
  assert.equal(md.render('[bad](javascript:alert)'), '<p>bad</p>')
  assert.match(md.render('go to https://preview-48.example.com. ok'), /href="https:\/\/preview-48.example.com"/)
  assert.match(md.render('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.equal(md.plain('**Bold** [x](https://y)'), 'Bold x')
})
