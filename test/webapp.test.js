'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')
const settle = () => new Promise(resolve => setImmediate(resolve))
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
const entry = { path: 'tanks.fuel.0.currentLevel', nickname: 'Fuel', type: 'number', display: 'percent', current: 0.42, available: true, saved: null, source: 'sensor', timestamp: '2026-11-12T06:00:00Z' }
const initial = () => ({ running: true, version: '0.1.0', entries: [{ ...entry }, { path: 'tanks.fuel.0.name', nickname: 'Name', type: 'string', display: 'native', current: 'Fuel port', available: true, saved: null }, { path: 'electrical.switches.manual.state', nickname: 'Enabled', type: 'boolean', display: 'native', current: false, available: true, saved: null }] })

async function fixture(t) {
  const { mount } = await import('../public/app.mjs')
  const dom = new JSDOM(html, { url: 'http://localhost:3000/signalk-s2k-add-data/' })
  let state = initial()
  let failure
  const requests = []
  const app = mount(dom.window.document, {
    interval: () => 1,
    clear() {},
    async fetch(url, options) {
      requests.push({ url: String(url), options })
      if (failure) return { ok: false, status: 403, headers: { get: () => 'application/json' }, json: async () => ({ error: failure }) }
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        const row = state.entries.find(row => row.path === body.path)
        row.current = body.value
        row.saved = { value: body.value, updatedAt: '2026-11-12T06:00:00Z' }
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => structuredClone(state) }
    }
  })
  t.after(() => { app.stop(); dom.window.close() })
  await app.ready
  return { document: dom.window.document, window: dom.window, app, requests, state, fail(message) { failure = message } }
}

test('tree grouping, live values and nicknames render; flat grouping retains edits', async t => {
  const f = await fixture(t)
  assert.equal(f.document.querySelectorAll('form').length, 3)
  assert.ok([...f.document.querySelectorAll('summary')].some(node => node.textContent === 'tanks'))
  assert.match(f.document.querySelector('form').textContent, /Current: 42%/)
  assert.equal(f.document.querySelector('input').value, '42')
  assert.match(f.requests[0].url, /\/plugins\/signalk-s2k-add-data\/state$/)
  const input = f.document.querySelector('input')
  input.value = '47'
  input.dispatchEvent(new f.window.Event('input'))
  f.document.getElementById('grouping').value = 'flat'
  f.document.getElementById('grouping').dispatchEvent(new f.window.Event('change'))
  assert.equal(f.document.querySelectorAll('details').length, 0)
  assert.equal(f.document.querySelector('input').value, '47')
})

test('polling refreshes live data without overwriting dirty inputs; save sends SI ratio', async t => {
  const f = await fixture(t)
  const input = f.document.querySelector('input')
  input.value = '47'
  input.dispatchEvent(new f.window.Event('input'))
  f.state.entries[0].current = 0.4
  await f.app.refresh()
  assert.equal(input.value, '47')
  assert.match(f.document.querySelector('form').textContent, /Current: 40%/)
  f.document.querySelector('form').dispatchEvent(new f.window.Event('submit', { cancelable: true }))
  await settle()
  const post = f.requests.find(item => item.options.method === 'POST')
  assert.deepEqual(JSON.parse(post.options.body), { path: entry.path, value: 0.47 })
  assert.match(f.document.querySelector('form').textContent, /Saved to disk and published/)
  assert.match(f.document.querySelector('form').textContent, /Last manual: 47%/)
})

test('text and booleans are typed; text cannot inject markup', async t => {
  const f = await fixture(t)
  const forms = f.document.querySelectorAll('form')
  forms[1].querySelector('input').value = '<img src=x onerror=alert(1)>'
  forms[1].dispatchEvent(new f.window.Event('submit', { cancelable: true }))
  await settle()
  assert.equal(forms[1].querySelector('img'), null)
  forms[2].querySelector('input').checked = true
  forms[2].dispatchEvent(new f.window.Event('submit', { cancelable: true }))
  await settle()
  const bodies = f.requests.filter(item => item.options.method === 'POST').map(item => JSON.parse(item.options.body))
  assert.equal(bodies[0].value, '<img src=x onerror=alert(1)>')
  assert.equal(bodies[1].value, true)
})

test('empty numbers fail locally and permission failures remain visible without optimistic success', async t => {
  const f = await fixture(t)
  const form = f.document.querySelector('form')
  const input = form.querySelector('input')
  input.value = ''
  form.dispatchEvent(new f.window.Event('submit', { cancelable: true }))
  await settle()
  assert.match(form.textContent, /empty field is not zero/)
  assert.equal(f.requests.filter(item => item.options.method === 'POST').length, 0)
  input.value = '50'
  f.fail('Permission denied')
  form.dispatchEvent(new f.window.Event('submit', { cancelable: true }))
  await settle()
  assert.equal(f.document.getElementById('error').hidden, false)
  assert.match(form.textContent, /Not confirmed: Permission denied/)
  assert.equal(form.querySelector('button').disabled, false)
})

test('stopped and empty states are explicit', async t => {
  const f = await fixture(t)
  f.state.running = false
  await f.app.refresh()
  assert.equal(f.document.querySelector('button[type=submit]').disabled, true)
  assert.match(f.document.getElementById('status').textContent, /Plugin stopped/)
  f.state.entries = []
  await f.app.refresh()
  assert.match(f.document.getElementById('entries').textContent, /No editable values/)
})
