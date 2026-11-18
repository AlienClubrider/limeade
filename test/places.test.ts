import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { displayFolder, folderPath, insideHome, isClutter, machines, matchesSearch, recentFolders } from '../src/domain/places.ts'
import { HomeFolderTree } from '../src/adapters/home-folders.ts'

const HOME = '/home/alex'

test('folder paths: ~, absolute and relative inside home are accepted', () => {
  assert.equal(folderPath(HOME, '~'), HOME)
  assert.equal(folderPath(HOME, '~/dev/notes-app/'), `${HOME}/dev/notes-app`)
  assert.equal(folderPath(HOME, `${HOME}/dev`), `${HOME}/dev`)
  assert.equal(folderPath(HOME, 'dev/./x'), `${HOME}/dev/x`)
})

test('folder paths: .., other users, other roots and junk are refused', () => {
  for (const bad of ['~/../root', '~/dev/../../etc', '/etc', '/home/alex2/x', '~root', '', '   ', 'a\0b', 42, null]) {
    assert.equal(folderPath(HOME, bad), null, String(bad))
  }
})

test('inside home, display and clutter', () => {
  assert.ok(insideHome(HOME, HOME))
  assert.ok(insideHome(HOME, `${HOME}/dev`))
  assert.ok(!insideHome(HOME, '/home/alexx'))
  assert.equal(displayFolder(HOME, `${HOME}/dev/x`), '~/dev/x')
  assert.equal(displayFolder(HOME, HOME), '~')
  assert.ok(isClutter('.git') && isClutter('node_modules') && !isClutter('dev'))
})

test('machines: this computer is the only one, by the name it is set up with', () => {
  assert.deepEqual(machines(), [{ id: 'homelab', label: 'This computer', kind: 'this-box', online: true }])
  assert.deepEqual(machines('Homelab'), [{ id: 'homelab', label: 'Homelab', kind: 'this-box', online: true }])
})

test('recent folders: newest chat first, no repeats', () => {
  const w = (folder: string) => ({ machine: 'homelab', folder })
  const recent = recentFolders([
    { where: w('/a'), updatedAt: '2026-01-01' },
    { where: w('/b'), updatedAt: '2026-01-03' },
    { where: w('/a'), updatedAt: '2026-01-02' },
    { updatedAt: '2026-01-04' },
  ])
  assert.deepEqual(recent, ['/b', '/a'])
})

test('search: every word must appear in the path below home', () => {
  assert.ok(matchesSearch(HOME, `${HOME}/dev/notes-app`, 'dev notes'))
  assert.ok(!matchesSearch(HOME, `${HOME}/dev/notes-app`, 'alex'))
  assert.ok(!matchesSearch(HOME, `${HOME}/dev`, ' '))
})

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'places-')))
  const home = join(root, 'home')
  mkdirSync(join(home, 'dev/notes-app/src'), { recursive: true })
  mkdirSync(join(home, 'dev/node_modules/x'), { recursive: true })
  mkdirSync(join(home, '.secret'), { recursive: true })
  mkdirSync(join(root, 'outside'))
  writeFileSync(join(home, 'dev/readme.md'), 'x')
  symlinkSync(join(root, 'outside'), join(home, 'escape'))
  symlinkSync(join(home, 'dev/notes-app'), join(home, 'rb'))
  return { root, home }
}

test('home folders: resolves real folders inside home, refuses files, .. and symlinks that escape', async () => {
  const { root, home } = tree()
  const f = new HomeFolderTree(home)
  assert.equal(await f.resolve('~/dev'), join(home, 'dev'))
  assert.equal(await f.resolve('~/rb'), join(home, 'dev/notes-app'))
  assert.equal(await f.resolve('~/escape'), null)
  assert.equal(await f.resolve(`${root}/outside`), null)
  assert.equal(await f.resolve('~/dev/readme.md'), null)
  assert.equal(await f.resolve('~/dev/../escape'), null)
  assert.equal(await f.resolve('~/nope'), null)
})

test('home files: resolves real files inside home, refuses folders, .. and links that escape', async () => {
  const { root, home } = tree()
  writeFileSync(join(root, 'outside/secret.txt'), 'x')
  symlinkSync(join(root, 'outside/secret.txt'), join(home, 'leak.txt'))
  const f = new HomeFolderTree(home)
  assert.equal(await f.resolveFile('~/dev/readme.md'), join(home, 'dev/readme.md'))
  assert.equal(await f.resolveFile(`${home}/rb/../dev/readme.md`), null)
  assert.equal(await f.resolveFile('~/dev'), null)
  assert.equal(await f.resolveFile('~/leak.txt'), null)
  assert.equal(await f.resolveFile(`${root}/outside/secret.txt`), null)
  assert.equal(await f.resolveFile('~/escape/secret.txt'), null)
})

test('home folders: lists folders only, no hidden, clutter or escaping links unless hidden is asked', async () => {
  const { home } = tree()
  const f = new HomeFolderTree(home)
  assert.deepEqual(await f.list('~'), [join(home, 'dev'), join(home, 'rb')])
  assert.deepEqual(await f.list('~/dev'), [join(home, 'dev/notes-app')])
  assert.ok((await f.list('~', { hidden: true })).includes(join(home, '.secret')))
  assert.ok(!(await f.list('~', { hidden: true })).includes(join(home, 'escape')))
  assert.deepEqual(await f.list('~/escape'), [])
})

test('home folders: search finds shallow matches first and skips clutter', async () => {
  const { home } = tree()
  const f = new HomeFolderTree(home)
  const found = await f.search('notes-app')
  assert.equal(found[0], join(home, 'dev/notes-app'))
  assert.deepEqual(await f.search('node_modules'), [])
  assert.deepEqual(await f.search(''), [])
})
