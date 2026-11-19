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

test('a link to a file the agent made opens through the hub and shows its name, copying its path (issues #9, #15)', () => {
  const chip = (path: string, name: string) => `<button type="button" class="pathchip" data-path="${path}" title="${path}" aria-label="Copy path ${path}"><span>${name}</span><svg`
  // What the Assistant said: the link text must not end up as bare words with nowhere to go.
  assert.equal(md.render('Here’s the diagram: [Open Purger diagram](/Users/me/dev/purger/diagram.html)').split('<svg')[0] + '<svg',
    '<p>Here’s the diagram: <a href="/files/Users/me/dev/purger/diagram.html" target="_blank" rel="noopener">Open Purger diagram</a> ' + chip('/Users/me/dev/purger/diagram.html', 'diagram.html'))
  assert.ok(md.render('[d](~/x/my%20d.html)').includes('href="/files/~/x/my%20d.html"'))
  assert.ok(md.render('[d](~/x/my%20d.html)').includes(chip('~/x/my d.html', 'my d.html')))
  assert.ok(md.render('[d](file:///Users/me/a%20b.html)').includes('href="/files/Users/me/a%20b.html"'))
  assert.ok(md.render('[d](file:///Users/me/a%20b.html)').includes(chip('/Users/me/a b.html', 'a b.html')))
  // Underscores and stars in a path stay as they are, not italics, in the name and the path behind it.
  const under = md.render('[d](/x/_a_/b_c*d*.html) _it_')
  assert.ok(under.startsWith('<p><a href="/files/x/%5Fa%5F/b%5Fc%2Ad%2A.html" target="_blank" rel="noopener">d</a> ' + chip('/x/_a_/b_c*d*.html', 'b_c*d*.html')), under)
  assert.ok(under.endsWith('</button> <em>it</em></p>'), under)
  // Quotes and brackets in a path can't break out of the chip.
  assert.ok(md.render('[x](/a"b<c.html)').includes(chip('/a&quot;b&lt;c.html', 'a&quot;b&lt;c.html')))
  // A source reference keeps its line in the link (the hub opens the file there) and in the short name.
  const ref = md.render('[Failure logging](/Users/me/p/AbstractPurgerProcessorTest.java:120)')
  assert.ok(ref.includes('href="/files/Users/me/p/AbstractPurgerProcessorTest.java%3A120"'))
  assert.ok(ref.includes(chip('/Users/me/p/AbstractPurgerProcessorTest.java:120', 'AbstractPurgerProcessorTest.java<wbr>:120')))
  assert.ok(md.render('[x](/Users/me/p/My%20Test.java:72:5)').includes('href="/files/Users/me/p/My%20Test.java%3A72%3A5"'))
  assert.ok(md.render('[x](/Users/me/p/My%20Test.java:72:5)').includes('<span>My Test.java<wbr>:72:5</span>'))
  // Somewhere this app can't open still shows where it pointed.
  assert.equal(md.render('[Open diagram](diagram.html)'), '<p>Open diagram <code>diagram.html</code></p>')
  assert.equal(md.plain('[Open diagram](/a/d.html)'), 'Open diagram')
})
