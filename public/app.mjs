export function displayValue(entry, value) {
  if (value === null || value === undefined) return 'Not available'
  if (entry.display === 'percent' && typeof value === 'number') return `${Number((value * 100).toFixed(6))}%`
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function readInput(entry, input) {
  if (entry.type === 'boolean') return input.checked
  if (entry.type === 'string') return input.value
  if (input.value.trim() === '') throw new Error('Enter a number; an empty field is not zero.')
  const value = Number(input.value)
  if (!Number.isFinite(value)) throw new Error('Enter a finite number.')
  return entry.display === 'percent' ? value / 100 : value
}

export function mount(document, { fetch: fetcher = globalThis.fetch, base = new URL('../plugins/signalk-s2k-add-data/', document.location.href), interval = globalThis.setInterval, clear = globalThis.clearInterval } = {}) {
  const container = document.getElementById('entries')
  const errorBox = document.getElementById('error')
  const status = document.getElementById('status')
  const grouping = document.getElementById('grouping')
  const refreshButton = document.getElementById('refresh')
  const rows = new Map()
  let latest = null
  let busy = false
  let stopped = false

  function element(tag, text, className) {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  function error(message) {
    errorBox.textContent = message
    errorBox.hidden = !message
  }
  async function request(route, options) {
    const response = await fetcher(new URL(route, base), { credentials: 'same-origin', cache: 'no-store', ...options })
    if (!response.ok) {
      let detail = `HTTP ${response.status}. Check your Signal K login and permissions.`
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        const body = await response.json()
        detail = body.error || detail
      }
      throw new Error(detail)
    }
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Expected JSON. Log into Signal K, then refresh.')
    return response.json()
  }

  function makeRow(entry) {
    const form = element('form', undefined, 'value-card')
    const title = element('h3', entry.nickname)
    const path = element('code', entry.path)
    const current = element('p')
    const saved = element('p', undefined, 'hint')
    const provenance = element('p', undefined, 'hint')
    const label = element('label', `New value${entry.display === 'percent' ? ' (%)' : ''}`)
    const input = element('input')
    input.id = `value-${entry.path}`
    label.htmlFor = input.id
    input.type = entry.type === 'boolean' ? 'checkbox' : entry.type === 'number' ? 'number' : 'text'
    if (entry.type === 'number') {
      input.step = 'any'
      input.required = true
      const scale = entry.display === 'percent' ? 100 : 1
      if (entry.minimum !== undefined) input.min = String(entry.minimum * scale)
      if (entry.maximum !== undefined) input.max = String(entry.maximum * scale)
      if (entry.display === 'percent') {
        input.min = String(Math.max(entry.minimum ?? 0, 0) * 100)
        input.max = String(Math.min(entry.maximum ?? 1, 1) * 100)
      }
    }
    if (entry.type === 'string') input.maxLength = 4096
    const button = element('button', 'Save and publish')
    button.type = 'submit'
    const feedback = element('p', '', 'feedback')
    feedback.setAttribute('role', 'status')
    const row = { form, input, button, current, saved, provenance, title, entry, dirty: false, saving: false }
    input.addEventListener('input', () => { row.dirty = true; feedback.textContent = '' })
    form.append(title, path, current, saved, provenance, label, input, button, feedback)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (row.saving || !latest?.running) return
      row.saving = true
      button.disabled = true
      input.disabled = true
      feedback.textContent = 'Saving...'
      try {
        const value = readInput(row.entry, input)
        const state = await request('values', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: row.entry.path, value }) })
        row.dirty = false
        row.saving = false
        render(state)
        error('')
        feedback.textContent = 'Saved to disk and published.'
      } catch (failure) {
        feedback.textContent = `Not confirmed: ${failure.message}`
        error(failure.message)
      } finally {
        row.saving = false
        button.disabled = !latest?.running
        input.disabled = !latest?.running
      }
    })
    return row
  }

  function rebuildGroups() {
    container.replaceChildren()
    const groups = new Map()
    for (const row of rows.values()) {
      let parent = container
      if (grouping.value === 'tree') {
        const segments = row.entry.path.split('.').slice(0, -1)
        for (let index = 0; index < segments.length; index++) {
          const key = segments.slice(0, index + 1).join('.')
          if (!groups.has(key)) {
            const details = element('details')
            details.open = true
            details.append(element('summary', segments[index]))
            parent.append(details)
            groups.set(key, details)
          }
          parent = groups.get(key)
        }
      }
      parent.append(row.form)
    }
  }

  function render(state) {
    latest = state
    status.textContent = state.running ? `Connected - ${state.entries.length} configured values - v${state.version}` : 'Plugin stopped. Enable it in Plugin Config.'
    if (state.lastError) error(state.lastError)
    let changed = false
    const paths = new Set(state.entries.map(entry => entry.path))
    for (const key of rows.keys()) {
      if (!paths.has(key)) { rows.delete(key); changed = true }
    }
    for (const entry of state.entries) {
      let row = rows.get(entry.path)
      if (row && (row.entry.type !== entry.type || row.entry.display !== entry.display ||
          row.entry.minimum !== entry.minimum || row.entry.maximum !== entry.maximum)) {
        rows.delete(entry.path)
        row = null
      }
      if (!row) {
        row = makeRow(entry)
        rows.set(entry.path, row)
        changed = true
      }
      row.entry = entry
      row.title.textContent = entry.nickname
      row.current.textContent = `Current: ${entry.available ? displayValue(entry, entry.current) : 'Not available'}`
      row.saved.textContent = entry.saved ? `Last manual: ${displayValue(entry, entry.saved.value)} - ${entry.saved.updatedAt}` : 'No manual value saved yet.'
      row.provenance.textContent = `Source: ${entry.source || 'unknown'} | Updated: ${entry.timestamp || 'unknown'}`
      row.button.disabled = !state.running || row.saving
      row.input.disabled = !state.running || row.saving
      if (!row.dirty && !row.saving && document.activeElement !== row.input) {
        const value = entry.saved ? entry.saved.value : entry.current
        if (entry.type === 'boolean') row.input.checked = value === true
        else row.input.value = value === null || value === undefined || typeof value !== entry.type ? '' : String(entry.display === 'percent' ? Number((value * 100).toFixed(6)) : value)
      }
    }
    if (changed) rebuildGroups()
    if (!rows.size) container.textContent = 'No editable values. Add entries in Plugin Config.'
  }

  async function refresh() {
    if (busy || stopped) return
    busy = true
    refreshButton.disabled = true
    try {
      const state = await request('state')
      if (!stopped) { error(''); render(state) }
    } catch (failure) { if (!stopped) error(failure.message) }
    finally { busy = false; refreshButton.disabled = false }
  }
  grouping.addEventListener('change', rebuildGroups)
  refreshButton.addEventListener('click', refresh)
  const ready = refresh()
  const timer = interval(refresh, 5000)
  return { ready, refresh, stop() { stopped = true; clear(timer) } }
}

if (typeof document !== 'undefined') mount(document)
