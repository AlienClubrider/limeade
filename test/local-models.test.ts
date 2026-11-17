import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PullProgress, estimateBytes, fitLabel, fitOf, fullTag, goodFor, isEmbedding, isModelRef, modelList, modelFamily, namesModel, notedEntries, parseSize, pickerName, shortDescription, usersOf,
  type InstalledModel, type OllamaMachine,
} from '../src/domain/local-models.ts'
import { RestartGate } from '../src/domain/restart-gate.ts'
import { parseLibrary, parseTags } from '../src/adapters/ollama-library.ts'
import { MachineModels } from '../src/app/machine-models.ts'
import type { LiteLlmEntry } from '../src/domain/local-models.ts'

const GPU: OllamaMachine = { id: 'gpu', label: 'GPU box', short: 'GPU', url: 'http://gpu:11434', prefix: '', fitsGb: 6.5, maxGb: 8 }
const MAC: OllamaMachine = { id: 'mac', label: 'MacBook Pro', short: 'Mac', url: 'http://mac:11434', prefix: 'mac-', fitsGb: 44, maxGb: 48 }
const model = (tag: string, size = 4.9e9, capabilities = ['completion', 'tools']): InstalledModel => ({ tag, size, parameterSize: '8.0B', capabilities })

test('model names: library names and tags pass; URLs, paths and flags do not', () => {
  for (const ok of ['qwen3', 'qwen3:8b', 'smollm2:135m', 'llama3.1:8b-instruct-q4_K_M', 'user/model:tag', 'gpt-oss:20b']) assert.ok(isModelRef(ok), ok)
  for (const bad of ['', 'http://x/y', '../etc', 'a/b/c', 'Qwen3', '-rf', 'a:b:c', 'a b', 'x'.repeat(70), 'qwen3:..', 42]) assert.ok(!isModelRef(bad), String(bad))
  assert.equal(fullTag('qwen3'), 'qwen3:latest')
  assert.equal(fullTag('qwen3:8b'), 'qwen3:8b')
})

test('fit: what runs comfortably, what is tight, what is too big, per machine', () => {
  assert.equal(fitOf(4.9e9, GPU), 'fits')
  assert.equal(fitOf(7.5e9, GPU), 'tight')
  assert.equal(fitOf(23e9, GPU), 'too-big')
  assert.equal(fitOf(23e9, MAC), 'fits')
  assert.equal(fitLabel('too-big', GPU), 'Too big for GPU box')
  // Ollama on another computer: memory unknown, nothing judged.
  const far = { ...GPU, fitsGb: 0, maxGb: 0 }
  assert.equal(fitOf(99e9, far), 'fits')
  assert.equal(fitLabel(fitOf(99e9, far), far), '')
  assert.equal(fitLabel('fits', MAC), 'Fits the Mac')
  assert.equal(estimateBytes('8b'), 4.9e9)
  assert.equal(estimateBytes('135m'), 181e6)
  assert.equal(estimateBytes('e4b'), 2.5e9)
  assert.equal(estimateBytes('latest'), null)
  assert.equal(parseSize('271MB'), 271e6)
  assert.equal(parseSize('4.7GB'), 4.7e9)
})

test('picker names: notes win, else the tag with :latest dropped and the machine prefix', () => {
  assert.equal(pickerName(GPU, 'qwen3:8b'), 'qwen3-8b')
  assert.equal(pickerName(MAC, 'qwen3:latest'), 'mac-qwen3')
  assert.equal(pickerName(GPU, 'llama3.1:8b', { name: 'llama3.1-8b' }), 'llama3.1-8b')
})

test('model list: one entry per chat model, notes kept, embedding models skipped, an offline machine keeps its entries', () => {
  const notes = { gpu: { 'llama3.1:8b': { name: 'llama3.1-8b', hint: 'General chat', tools: false } } }
  const previous = notedEntries([GPU, MAC], { mac: { 'llama3.1:8b': { name: 'mac-llama3.1-8b', hint: 'On the Mac', tools: false } } })
  const list = modelList([GPU, MAC], new Map([
    ['gpu', [model('llama3.1:8b'), model('nomic-embed-text:latest', 2.7e8, ['embedding']), model('flint:40b', 22.8e9, ['completion', 'tools', 'thinking']), model('phi:2b', 1.6e9, ['completion'])]],
    ['mac', null],
  ]), notes, previous)
  assert.deepEqual(list.map((e) => e.model_name), ['flint-40b', 'llama3.1-8b', 'phi-2b', 'mac-llama3.1-8b'])
  const [flint, llama, phi, mac] = list
  assert.equal(llama!.model_info.hint, 'General chat · 8.0B · 4.9 GB') // the note's hint wins over the table
  assert.equal(llama!.model_info.tools, false) // the note says so, though Ollama lists "tools"
  assert.equal(flint!.model_info.supports_function_calling, true)
  assert.match(flint!.model_info.hint, /23 GB · slow here/)
  assert.equal(phi!.model_info.tools, false) // no tools capability: chat only
  assert.equal(phi!.model_info.hint, '8.0B · 1.6 GB') // unknown family, no description: sizes only
  assert.equal(mac!.model_info.machine, 'MacBook Pro')
  assert.equal(llama!.litellm_params.model, 'ollama_chat/llama3.1:8b')
  assert.equal(llama!.litellm_params.api_base, 'http://gpu:11434')
  assert.equal(llama!.litellm_params.num_ctx, 32768)
})

test('good for: table by family, small sizes their own line, note wins, else a trimmed library description', () => {
  assert.equal(goodFor('gemma4:26b'), 'Everyday questions, writing, summaries')
  assert.equal(goodFor('qwen3-coder:30b'), 'Coding and file work')
  assert.equal(goodFor('qwen3.8:27b'), 'Strong all-rounder, reasoning')
  assert.equal(goodFor('llama3.1:8b'), 'Simple chat')
  assert.equal(goodFor('qwen2.5:3b'), 'Quick, light tasks')
  assert.equal(goodFor('qwen2.5:7b'), 'Good at code and lists')
  assert.equal(goodFor('qwen2.5:latest', { parameterSize: '3.1B' }), 'Quick, light tasks') // size from Ollama when the tag has none
  assert.equal(goodFor('qwen2.5:14b-instruct-q4_K_M'), 'Good at code and lists')
  assert.equal(goodFor('nomic-embed-text:latest'), 'Search embeddings')
  assert.equal(goodFor('library/gemma4:e4b'), 'Quick, light tasks')
  assert.equal(goodFor('qwen2.5'), 'Good at code and lists') // a library name, no size
  assert.equal(goodFor('llama3.1:8b', { note: { hint: 'General chat' } }), 'General chat')
  assert.equal(goodFor('newthing:7b', { description: 'Newthing is a family of open models built for agents and long documents. Very good.' }),
    'Newthing is a family of open models built…')
  assert.equal(goodFor('newthing:7b'), '')
  assert.equal(modelFamily('user/model:tag'), 'model')
  assert.equal(shortDescription("Meta's Llama 3.1. It is good."), "Meta's Llama 3.1")
})

test('model list: a model the table doesn\'t know gets its library description', () => {
  const [e] = modelList([GPU], new Map([['gpu', [model('newthing:7b')]]]), {}, [], new Map([['newthing', 'Tiny agent model.']]))
  assert.equal(e!.model_info.hint, 'Tiny agent model · 8.0B · 4.9 GB')
})

test('model list: two tags that come out as the same name both stay reachable', () => {
  const list = modelList([GPU], new Map([['gpu', [model('a-b:c'), model('a:b-c')]]]), {}, [])
  assert.deepEqual(list.map((e) => e.model_name), ['a-b-c', 'a-b-c-2'])
})

test('pull progress adds up the layers', () => {
  const p = new PullProgress()
  p.add({ status: 'pulling manifest' })
  p.add({ status: 'pulling a', digest: 'a', total: 100, completed: 50 })
  p.add({ status: 'pulling b', digest: 'b', total: 300, completed: 0 })
  assert.equal(p.percent, 12)
  p.add({ status: 'pulling b', digest: 'b', total: 300, completed: 300 })
  assert.equal(p.completed, 350)
  p.add({ status: 'success' })
  assert.equal(p.status, 'success')
})

test('restart gate: a restart waits for running turns, and new turns wait for the restart', async () => {
  const gate = new RestartGate()
  const order: string[] = []
  let finishTurn: () => void = () => {}
  const turn = gate.through(() => new Promise<void>((r) => { finishTurn = () => { order.push('turn 1 done'); r() } }))
  const restart = gate.restart(async () => { order.push('restart'); await new Promise((r) => setTimeout(r, 10)); order.push('restarted') })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(order.length, 0) // still waiting for turn 1
  finishTurn()
  await new Promise((r) => setTimeout(r, 1))
  const turn2 = gate.through(async () => { order.push('turn 2') })
  await Promise.all([turn, restart, turn2])
  assert.deepEqual(order, ['turn 1 done', 'restart', 'restarted', 'turn 2'])
})

test('restart gate: a failed restart lets turns through and reports the failure', async () => {
  const gate = new RestartGate()
  await assert.rejects(gate.restart(async () => { throw new Error('nope') }), /nope/)
  assert.equal(await gate.through(async () => 'ok'), 'ok')
})

test('ollama.com library page: names, descriptions, badges, sizes; cloud-only models left out, embedding models kept', () => {
  const models = parseLibrary(readFileSync(new URL('./fixtures/ollama-library.html', import.meta.url), 'utf8'))
  assert.deepEqual(models.map((m) => m.name).sort(), ['llama3.1', 'nomic-embed-text', 'qwen3'])
  assert.ok(models.find((m) => m.name === 'nomic-embed-text')!.capabilities.includes('embedding'))
  const qwen = models.find((m) => m.name === 'qwen3')!
  assert.match(qwen.description, /^Qwen3 is the latest generation/)
  assert.deepEqual(qwen.capabilities, ['tools', 'thinking'])
  assert.ok(qwen.sizes.includes('8b'))
  assert.equal(qwen.pulls, '43.6M')
})

test('ollama.com tags page: main tags with sizes, no quantization variants', () => {
  const tags = parseTags(readFileSync(new URL('./fixtures/ollama-tags.html', import.meta.url), 'utf8'), 'smollm2')
  assert.deepEqual(tags, [
    { tag: 'smollm2:latest', bytes: 1.8e9, context: '8K' },
    { tag: 'smollm2:135m', bytes: 271e6, context: '8K' },
    { tag: 'smollm2:360m', bytes: 726e6, context: '8K' },
    { tag: 'smollm2:1.7b', bytes: 1.8e9, context: '8K' },
  ])
})

test('embedding models: told apart from chat models, and found by name in a user\'s config', () => {
  assert.ok(isEmbedding({ capabilities: ['embedding'] }))
  assert.ok(!isEmbedding({ capabilities: ['completion', 'tools'] }))
  assert.ok(!isEmbedding({ capabilities: [] }))
  const yaml = 'providers:\n  embedding:\n    ollama:\n      model: nomic-embed-text\n'
  assert.ok(namesModel(yaml, 'nomic-embed-text:latest'))
  assert.ok(namesModel('EMBED_MODEL = "nomic-embed-text:latest"', 'nomic-embed-text:latest'))
  assert.ok(namesModel('model: nomic-embed-text:v1.5', 'nomic-embed-text:v1.5'))
  assert.ok(!namesModel('model: nomic-embed-text:v1.5', 'nomic-embed-text:latest'))
  assert.ok(!namesModel(yaml, 'nomic-embed-text:v1.5'))
  assert.ok(!namesModel('model: nomic-embed-text-v2', 'nomic-embed-text:latest'))
  assert.ok(!namesModel('model: my-nomic-embed-text', 'nomic-embed-text:latest'))
  assert.ok(!namesModel('model: qwen3x', 'qwen3:latest'))
  const users = [{ name: 'SearchTool', machine: 'gpu', text: yaml }, { name: 'Other', text: 'nothing here' }]
  assert.deepEqual(usersOf('gpu', 'nomic-embed-text:latest', users), ['SearchTool'])
  assert.deepEqual(usersOf('mac', 'nomic-embed-text:latest', users), [])
})

// ---------- the use case, with fake machines ----------

function fakes(opts: { gpu?: InstalledModel[] | null; mac?: InstalledModel[] | null; library?: { name: string; description: string }[] } = {}) {
  const installed: Record<string, InstalledModel[] | null> = { gpu: opts.gpu === undefined ? [model('llama3.1:8b')] : opts.gpu, mac: opts.mac ?? null }
  let file: LiteLlmEntry[] | null = null
  const calls: string[] = []
  let pullLines: ((line: Record<string, unknown>) => void) | null = null
  let finishPull: ((err?: Error) => void) | null = null
  const mm = new MachineModels({
    machines: [GPU, MAC],
    notes: {},
    gate: new RestartGate(),
    progressMs: 0,
    users: [{ name: 'SearchTool', machine: 'gpu', files: ['/og/cluster.yaml', '/og/missing.py'] }],
    readText: async (path) => (path === '/og/cluster.yaml' ? 'model: nomic-embed-text\n' : null),
    library: {
      models: async () => ({ models: (opts.library ?? []).map((x) => ({ ...x, capabilities: [], sizes: [], pulls: '' })), fetchedAt: null, fallback: true }),
      tags: async () => [],
    },
    file: {
      read: async () => file,
      write: async (e) => { file = [...e]; calls.push(`write ${e.map((x) => x.model_name).join(',')}`) },
      restart: async () => { calls.push('restart') },
    },
    ollama: {
      installed: async (m) => installed[m.id] ?? null,
      pull: (m, tag, signal, onLine) => new Promise<void>((resolve, reject) => {
        calls.push(`pull ${tag} on ${m.id}`)
        pullLines = onLine
        finishPull = (err) => (err ? reject(err) : resolve())
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
      remove: async (m, tag) => {
        calls.push(`remove ${tag} on ${m.id}`)
        installed[m.id] = installed[m.id]!.filter((x) => x.tag !== tag)
      },
    },
  })
  return { mm, calls, installed, line: (l: Record<string, unknown>) => pullLines!(l), finish: (err?: Error) => finishPull!(err) }
}

test('overview: embedding models listed with their size and who uses them, but kept out of LiteLLM', async () => {
  const f = fakes({ gpu: [model('llama3.1:8b'), model('nomic-embed-text:latest', 2.7e8, ['embedding']), model('mxbai-embed-large:latest', 6.7e8, ['embedding'])] })
  const gpu = (await f.mm.overview()).machines[0]!
  assert.deepEqual(gpu.models.map((x) => [x.tag, x.kind, x.usedBy]), [
    ['llama3.1:8b', 'chat', []],
    ['mxbai-embed-large:latest', 'embedding', []],
    ['nomic-embed-text:latest', 'embedding', ['SearchTool']],
  ])
  const nomic = gpu.models.find((x) => x.tag.startsWith('nomic'))!
  assert.equal(nomic.sizeLabel, '270 MB')
  assert.equal(nomic.tools, false)
  assert.equal(gpu.installedLabel, '5.8 GB')
  await f.mm.sync()
  assert.deepEqual(f.calls, ['write llama3.1-8b', 'restart'])
})

test('overview and library: each model says what it is good for', async () => {
  const f = fakes({
    gpu: [model('qwen2.5:3b', 1.9e9), model('nomic-embed-text:latest', 2.7e8, ['embedding']), model('oddity:7b')],
    library: [{ name: 'oddity', description: 'An odd model for odd jobs.' }, { name: 'gemma4', description: "Google's Gemma 4." }],
  })
  const gpu = (await f.mm.overview()).machines[0]!
  assert.deepEqual(gpu.models.map((x) => [x.tag, x.goodFor]), [
    ['nomic-embed-text:latest', 'Search embeddings'],
    ['oddity:7b', 'An odd model for odd jobs'],
    ['qwen2.5:3b', 'Quick, light tasks'],
  ])
  const lib = await f.mm.library()
  assert.deepEqual(lib.models.map((x) => [x.name, x.goodFor]), [['oddity', null], ['gemma4', 'Everyday questions, writing, summaries']])
})

test('sync writes the list and restarts LiteLLM only when the list changed', async () => {
  const f = fakes()
  await f.mm.sync()
  await f.mm.sync()
  assert.deepEqual(f.calls, ['write llama3.1-8b', 'restart'])
})

test('pull: one per machine, progress goes out, and the new model reaches LiteLLM', async () => {
  const f = fakes()
  await f.mm.sync()
  const events: any[] = []
  f.mm.on('pull', (s) => events.push(s))
  const changed = new Promise((r) => f.mm.once('local_models', r))
  f.mm.pull('gpu', 'smollm2:135m')
  assert.throws(() => f.mm.pull('gpu', 'qwen3'), /already downloading smollm2:135m/)
  assert.throws(() => f.mm.pull('gpu', 'http://evil/x'), /Not a model name/)
  assert.throws(() => f.mm.pull('nas', 'qwen3'), /No such machine/)
  f.line({ status: 'pulling x', digest: 'x', total: 200, completed: 100 })
  f.installed.gpu!.push(model('smollm2:135m', 2.7e8))
  f.line({ status: 'success' })
  f.finish()
  await changed
  assert.equal(events.at(-1).state, 'done')
  assert.ok(events.some((e) => e.percent === 50))
  assert.deepEqual(f.calls.slice(2), ['pull smollm2:135m on gpu', 'write llama3.1-8b,smollm2-135m', 'restart'])
  const view = await f.mm.overview()
  assert.equal(view.machines[0]!.pull?.state, 'done')
  assert.equal(view.machines[1]!.online, false)
  assert.equal(view.machines[1]!.installedLabel, '')
  assert.equal(typeof view.machines[0]!.memoryGb, 'number')
  assert.match(view.machines[0]!.installedLabel, /\d (MB|GB)$/)
})

test('pull: cancel stops it; a stream that ends early is a failure, not a success', async () => {
  const f = fakes()
  const done = new Promise<any>((r) => f.mm.on('pull', (s) => s.state !== 'pulling' && r(s)))
  f.mm.pull('gpu', 'qwen3:8b')
  assert.equal(f.mm.cancel('gpu'), true)
  assert.equal((await done).state, 'cancelled')

  const f2 = fakes()
  const failed = new Promise<any>((r) => f2.mm.on('pull', (s) => s.state !== 'pulling' && r(s)))
  f2.mm.pull('gpu', 'qwen3:8b')
  f2.finish()
  assert.equal((await failed).state, 'failed')
  assert.ok(!f2.calls.includes('restart'))
})

test('remove: only an installed model, then LiteLLM drops it', async () => {
  const f = fakes({ gpu: [model('llama3.1:8b'), model('smollm2:135m', 2.7e8)] })
  await f.mm.sync()
  await assert.rejects(f.mm.remove('gpu', 'qwen3:8b'), /isn't on GPU box/)
  await assert.rejects(f.mm.remove('mac', 'llama3.1:8b'), /isn't answering/)
  await f.mm.remove('gpu', 'smollm2:135m')
  assert.deepEqual(f.calls.slice(2), ['remove smollm2:135m on gpu', 'write llama3.1-8b', 'restart'])
})
