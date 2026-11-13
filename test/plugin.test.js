'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const createPlugin = require('../index')
const { configure, load, persist } = require('../lib/values')

const entries = [
  { path: 'tanks.fuel.0.currentLevel', nickname: 'Fuel', type: 'number', display: 'percent' },
  { path: 'tanks.fuel.0.name', nickname: 'Tank name', type: 'string' },
  { path: 'electrical.switches.manual.state', nickname: 'Switch', type: 'boolean' }
]

function fixture(t, options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 's2k-test-'))
  if (!options.dir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const data = {}
  const messages = []
  const errors = []
  const routes = new Map()
  const levels = []
  let publicationError
  const app = {
    getDataDirPath: () => dir,
    getSelfPath: key => data[key],
    setPluginStatus() {},
    setPluginError: message => errors.push(message),
    error: message => errors.push(message),
    handleMessage(source, delta) {
      if (publicationError) throw publicationError
      messages.push({ source, delta })
      for (const update of delta.updates) for (const item of update.values) {
        data[item.path] = { value: item.value, timestamp: update.timestamp, $source: source }
      }
    }
  }
  const plugin = createPlugin(app)
  const router = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler)
  }
  if (!options.legacy) router.access = level => { levels.push(level); return router }
  plugin.registerWithRouter(router)
  function request(method, route, body, origin = 'http://localhost:3000') {
    const result = { status: 200, headers: {} }
    const req = { protocol: 'http', body, get: name => ({ Origin: origin, Host: 'localhost:3000' })[name] }
    const res = {
      set(name, value) { result.headers[name] = value; return this },
      status(value) { result.status = value; return this },
      json(body) { result.body = body; return this }
    }
    routes.get(`${method} ${route}`)(req, res)
    return result
  }
  return { dir, plugin, request, messages, errors, data, levels, failPublish(error) { publicationError = error } }
}

test('configured paths only, strict types, bounds, ratios and safe paths', () => {
  for (const bad of [
    { entries: [{ path: 'vessels.self.navigation.speedOverGround', type: 'number' }] },
    { entries: [{ path: 'tanks.__proto__.value', type: 'number' }] },
    { entries: [{ path: 'tanks.constructor.value', type: 'number' }] },
    { entries: [{ path: 'name', type: 'string' }] },
    { entries: [{ path: 'bad..path', type: 'string' }] },
    { entries: [{ ...entries[0], type: 'object' }] },
    { entries: [entries[0], entries[0]] },
    { entries: [entries[0], { path: 'tanks.fuel.0', type: 'string' }] },
    { entries: [{ ...entries[0], minimum: 2, maximum: 1 }] },
    { entries: [{ ...entries[1], display: 'percent' }] },
    { entries: [{ ...entries[1], minimum: 0 }] },
    { entries: [{ ...entries[0], minimum: Infinity }] },
    { entries: [{ ...entries[0], group: 42 }] },
    { entries: [{ ...entries[0], group: null }] },
    { entries: [{ ...entries[0], group: 'x'.repeat(121) }] }
  ]) assert.throws(() => configure(bad))
  assert.deepEqual(configure(), [])
  assert.equal(configure({ entries: [{ ...entries[0], group: '  Engine room  ' }] })[0].group, 'Engine room')
  assert.equal(configure({ entries: [{ ...entries[0], group: '   ' }] })[0].group, '')
  assert.equal(configure({ entries: [entries[0]] })[0].group, '')
})

test('group configuration is exposed in state without changing saved values or startup restoration', t => {
  const f = fixture(t)
  assert.equal(f.plugin.schema.properties.entries.items.properties.group.type, 'string')
  f.plugin.start({ entries: [{ ...entries[0], group: ' Tanks ' }] })
  assert.equal(f.request('GET', '/state').body.entries[0].group, 'Tanks')
  assert.equal(f.request('POST', '/values', { path: entries[0].path, value: 0.42 }).status, 200)
  f.plugin.stop()
  const restarted = fixture(t, { dir: f.dir })
  restarted.plugin.start({ entries: [{ ...entries[0], group: 'Fuel' }] })
  assert.equal(restarted.request('GET', '/state').body.entries[0].group, 'Fuel')
  assert.equal(restarted.messages.at(-1).delta.updates[0].values[0].value, 0.42)
})

test('publishes typed self deltas, persists and restores through a new instance', t => {
  const f = fixture(t)
  assert.deepEqual(f.levels, ['readonly', 'readwrite'])
  f.plugin.start({ entries })
  assert.equal(f.messages.length, 0, 'No invented default values')
  const writes = [0.42, 'Fuel port', false]
  for (let index = 0; index < entries.length; index++) {
    const result = f.request('POST', '/values', { path: entries[index].path, value: writes[index] })
    assert.equal(result.status, 200)
    assert.equal(result.headers['Cache-Control'], 'no-store')
    assert.equal(result.body.entries[index].saved.value, writes[index])
    assert.equal(f.messages[index].delta.context, 'vessels.self')
    assert.equal(f.messages[index].delta.updates[0].source.label, f.plugin.id)
  }
  const restored = fixture(t, { dir: f.dir })
  restored.plugin.start({ entries })
  assert.equal(restored.messages.length, 1)
  assert.deepEqual(restored.messages[0].delta.updates[0].values, entries.map((entry, index) => ({ path: entry.path, value: writes[index] })))
  assert.deepEqual(f.errors, [])
  assert.equal(fs.statSync(path.join(f.dir, 'values.json')).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(f.dir, 'values.json.tmp')), false)
})

test('live values differ from saved manual values without republishing', t => {
  const f = fixture(t)
  f.plugin.start({ entries })
  f.request('POST', '/values', { path: entries[0].path, value: 0.42 })
  f.data[entries[0].path] = { value: 0.39, $source: 'sensor', timestamp: '2026-11-12T06:00:00Z' }
  f.data[entries[1].path] = 'Primitive name'
  const state = f.request('GET', '/state').body
  assert.equal(state.entries[0].current, 0.39)
  assert.equal(state.entries[0].saved.value, 0.42)
  assert.equal(state.entries[0].source, 'sensor')
  assert.equal(state.entries[1].current, 'Primitive name')
  assert.equal(state.entries[2].available, false)
  assert.equal(f.messages.length, 1)
})

test('invalid edits and cross-origin writes are rejected and logged without disk changes', t => {
  const f = fixture(t)
  f.plugin.start({ entries: [{ ...entries[0], minimum: 0.1, maximum: 0.9 }, ...entries.slice(1)] })
  const bodies = [
    { path: 'navigation.speedOverGround', value: 2 },
    { path: entries[0].path, value: '0.42' },
    { path: entries[0].path, value: null },
    { path: entries[0].path, value: Infinity },
    { path: entries[0].path, value: NaN },
    { path: entries[0].path, value: -0.1 },
    { path: entries[0].path, value: 0.95 },
    { path: entries[2].path, value: 'false' },
    { path: entries[1].path, value: 'x'.repeat(4097) },
    { path: entries[0].path, value: 0.42, extra: true },
    { path: entries[0].path },
    null
  ]
  for (const body of bodies) assert.ok(f.request('POST', '/values', body).status >= 400)
  assert.equal(f.request('POST', '/values', { path: entries[0].path, value: 0.42 }, 'http://evil.example').status, 403)
  assert.equal(f.request('POST', '/values', { path: entries[0].path, value: 0.42 }, 'null').status, 403)
  assert.ok(f.errors.length >= bodies.length)
  assert.equal(f.messages.length, 0)
  assert.equal(fs.existsSync(path.join(f.dir, 'values.json')), false)
})

test('disk failure never publishes; corrupt persistence fails startup explicitly', t => {
  const f = fixture(t)
  f.plugin.start({ entries })
  fs.mkdirSync(path.join(f.dir, 'values.json'))
  assert.equal(f.request('POST', '/values', { path: entries[0].path, value: 0.42 }).status, 500)
  assert.equal(f.messages.length, 0)
  assert.ok(f.errors.length)
  fs.rmdirSync(path.join(f.dir, 'values.json'))
  fs.writeFileSync(path.join(f.dir, 'values.json'), '{broken')
  assert.throws(() => f.plugin.start({ entries }))
  assert.equal(f.request('GET', '/state').body.running, false)
})

test('publication failure reports persisted data and restart restores it', t => {
  const f = fixture(t)
  f.plugin.start({ entries })
  f.failPublish(new Error('Cannot publish'))
  const result = f.request('POST', '/values', { path: entries[0].path, value: 0.42 })
  assert.equal(result.status, 503)
  assert.equal(result.body.persisted, true)
  assert.equal(load(path.join(f.dir, 'values.json'))[entries[0].path].value, 0.42)
  assert.ok(f.errors.includes('Cannot publish'))
  f.failPublish(null)
  f.plugin.start({ entries })
  assert.equal(f.messages[0].delta.updates[0].values[0].value, 0.42)
})

test('removed paths are not restored and incompatible saved types fail explicitly', t => {
  const f = fixture(t)
  f.plugin.start({ entries })
  f.request('POST', '/values', { path: entries[0].path, value: 0.42 })
  f.plugin.start({ entries: [] })
  assert.equal(f.messages.length, 1)
  assert.equal(f.request('POST', '/values', { path: entries[0].path, value: 0.3 }).status, 403)
  assert.throws(() => f.plugin.start({ entries: [{ ...entries[0], type: 'string', display: 'native' }] }), /Saved type differs/)
})

test('legacy router retains default admin authentication and stopped plugin refuses writes', t => {
  const f = fixture(t, { legacy: true })
  assert.deepEqual(f.levels, [])
  assert.equal(f.request('POST', '/values', { path: entries[0].path, value: 0.42 }).status, 503)
  f.plugin.start({ entries })
  f.plugin.stop()
  assert.equal(f.request('GET', '/state').body.running, false)
  assert.equal(f.request('POST', '/values', { path: entries[0].path, value: 0.42 }).status, 503)
})

test('saved-file envelope and all stored records are validated', t => {
  const f = fixture(t)
  const filename = path.join(f.dir, 'values.json')
  for (const data of [
    { version: 2, values: {} },
    { version: 1, values: [] },
    { version: 1, values: { 'tanks.fuel.0.name': { type: 'string', value: 42, updatedAt: new Date().toISOString() } } }
  ]) {
    fs.writeFileSync(filename, JSON.stringify(data))
    assert.throws(() => load(filename))
  }
  persist(filename, {})
  assert.deepEqual(load(filename), {})
})
