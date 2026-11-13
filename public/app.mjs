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
  const version = document.getElementById('version')
  const actionStatus = document.getElementById('action-status')
  const details = document.getElementById('value-details')
  const grouping = document.getElementById('grouping')
  const refreshButton = document.getElementById('refresh')
  const rows = new Map()
  const groupOpen = new Map()
  let latest = null
  let busy = false
  let stopped = false
  let selectedPath = null
  let errorKind = null

  function element(tag, text, className) {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  function error(message, kind = null) {
    errorBox.textContent = message
    errorBox.hidden = !message
    errorKind = message ? kind : null
  }
  function showDetails(entry) {
    document.getElementById('details-name').textContent = entry.nickname
    document.getElementById('details-path').textContent = entry.path
    document.getElementById('details-source').textContent = entry.source || 'unknown'
    document.getElementById('details-updated').textContent = entry.timestamp || 'unknown'
    document.getElementById('details-saved').textContent = entry.saved
      ? `${displayValue(entry, entry.saved.value)} - ${entry.saved.updatedAt}`
      : 'No manual value saved yet.'
    details.hidden = false
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
    const form = element('form', undefined, 'value-row')
    const title = element('button', entry.nickname, 'value-name')
    title.type = 'button'
    title.title = 'Show value details'
    const current = element('span', undefined, 'value-current')
    const label = element('label', `New value for ${entry.nickname}${entry.display === 'percent' ? ' (%)' : ''}`, 'sr-only')
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
    const button = element('button', 'Save')
    button.type = 'submit'
    const row = { form, input, button, current, title, label, entry, dirty: false, saving: false }
    title.addEventListener('click', () => { selectedPath = row.entry.path; showDetails(row.entry) })
    input.addEventListener('input', () => { row.dirty = true })
    form.append(title, current, label, input, button)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (row.saving || !latest?.running) return
      row.saving = true
      button.disabled = true
      input.disabled = true
      actionStatus.textContent = `Saving ${row.entry.nickname}...`
      try {
        const value = readInput(row.entry, input)
        const state = await request('values', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: row.entry.path, value }) })
        row.dirty = false
        row.saving = false
        render(state)
        error('')
        actionStatus.textContent = `${row.entry.nickname}: saved to disk and published.`
      } catch (failure) {
        actionStatus.textContent = `${row.entry.nickname}: save not confirmed.`
        error(failure.message, 'save')
      } finally {
        row.saving = false
        button.disabled = !latest?.running
        input.disabled = !latest?.running
      }
    })
    return row
  }

  function rebuildGroups() {
    for (const group of container.querySelectorAll('details')) {
      groupOpen.set(group.firstElementChild.textContent, group.open)
    }
    container.replaceChildren()
    if (grouping.value === 'flat') {
      for (const row of rows.values()) container.append(row.form)
      return
    }

    const groups = new Map()
    for (const row of rows.values()) {
      const name = row.entry.group || 'Ungrouped'
      if (!groups.has(name)) {
        const group = element('details')
        group.open = groupOpen.get(name) ?? true
        group.append(element('summary', name))
        groups.set(name, group)
        container.append(group)
      }
      groups.get(name).append(row.form)
    }
  }

  function render(state) {
    latest = state
    version.textContent = `v${state.version}`
    status.textContent = state.running ? `Connected - ${state.entries.length} configured values` : 'Plugin stopped. Enable it in Plugin Config.'
    if (state.lastError) error(state.lastError)
    let changed = false
    const previousOrder = [...rows.keys()]
    const paths = new Set(state.entries.map(entry => entry.path))
    for (const key of rows.keys()) {
      if (!paths.has(key)) { rows.delete(key); changed = true }
    }
    for (const entry of state.entries) {
      let row = rows.get(entry.path)
      if (row && row.entry.group !== entry.group) changed = true
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
      row.title.textContent = `${entry.nickname}:`
      row.title.setAttribute('aria-label', `${entry.nickname}: show value details`)
      row.label.textContent = `New value for ${entry.nickname}${entry.display === 'percent' ? ' (%)' : ''}`
      row.current.textContent = entry.available ? displayValue(entry, entry.current) : 'Not available'
      row.current.title = `Current: ${row.current.textContent}`
      row.current.setAttribute('aria-label', `Current value: ${row.current.textContent}`)
      if (selectedPath === entry.path) showDetails(entry)
      row.button.disabled = !state.running || row.saving
      row.input.disabled = !state.running || row.saving
      if (!row.dirty && !row.saving && document.activeElement !== row.input) {
        const value = entry.saved ? entry.saved.value : entry.current
        if (entry.type === 'boolean') row.input.checked = value === true
        else row.input.value = value === null || value === undefined || typeof value !== entry.type ? '' : String(entry.display === 'percent' ? Number((value * 100).toFixed(6)) : value)
      }
    }
    if (changed || previousOrder.length !== state.entries.length ||
        state.entries.some((entry, index) => entry.path !== previousOrder[index])) {
      const orderedRows = state.entries.map(entry => [entry.path, rows.get(entry.path)])
      rows.clear()
      for (const [path, row] of orderedRows) rows.set(path, row)
      changed = true
    }
    if (changed) rebuildGroups()
    if (selectedPath && !paths.has(selectedPath)) { selectedPath = null; details.hidden = true }
    if (!rows.size) container.textContent = 'No editable values. Add entries in Plugin Config.'
  }

  async function refresh() {
    if (busy || stopped) return
    busy = true
    refreshButton.disabled = true
    try {
      const state = await request('state')
      if (!stopped) { if (errorKind === 'refresh') error(''); render(state) }
    } catch (failure) { if (!stopped) error(failure.message, 'refresh') }
    finally { busy = false; refreshButton.disabled = false }
  }
  grouping.addEventListener('change', rebuildGroups)
  document.getElementById('close-details').addEventListener('click', () => { selectedPath = null; details.hidden = true })
  refreshButton.addEventListener('click', refresh)
  const ready = refresh()
  const timer = interval(refresh, 5000)
  return { ready, refresh, stop() { stopped = true; clear(timer) } }
}

if (typeof document !== 'undefined') mount(document)
