'use strict'

const path = require('node:path')
const { InputError, configure, isRecord, load, persist, validateValue } = require('./lib/values')
const { version } = require('./package.json')

module.exports = function (app) {
  let running = false
  let entries = []
  let saved = {}
  let filename
  let lastError = null
  const plugin = {
    id: 'signalk-s2k-add-data',
    name: 'S2KaddData',
    description: 'Edit configured self values. Manual values are persisted and restored at startup.',
    schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array', title: 'Editable self values', default: [],
          items: {
            type: 'object', required: ['path', 'type'],
            properties: {
              path: { type: 'string', title: 'Signal K path', description: 'Relative to vessels.self, e.g. tanks.fuel.0.currentLevel.' },
              nickname: { type: 'string', title: 'Nickname', default: '' },
              group: { type: 'string', title: 'Group', default: '', maxLength: 120, description: 'Optional. Values without a group appear under Ungrouped.' },
              type: { type: 'string', title: 'Value type', enum: ['number', 'string', 'boolean'], default: 'number' },
              display: { type: 'string', title: 'Number display', enum: ['native', 'percent'], default: 'native', description: 'Percent converts 42 in the webapp to the Signal K ratio 0.42.' },
              minimum: { type: 'number', title: 'Minimum (optional, Signal K units)' },
              maximum: { type: 'number', title: 'Maximum (optional, Signal K units)' }
            }
          }
        }
      }
    },
    start(options) {
      plugin.stop()
      try {
        entries = configure(options)
        filename = path.join(app.getDataDirPath(), 'values.json')
        saved = load(filename)
        const values = []
        for (const entry of entries) {
          const record = saved[entry.path]
          if (!record) continue
          if (record.type !== entry.type) throw new Error(`Saved type differs for ${entry.path}. Restore its configured type or back up and correct values.json.`)
          validateValue(entry, record.value)
          values.push({ path: entry.path, value: record.value })
        }
        if (values.length) publish(values)
        running = true
        lastError = null
        app.setPluginStatus(`${entries.length} editable paths; restored ${values.length} saved values.`)
      } catch (error) {
        report(error)
        throw error
      }
    },
    stop() {
      running = false
      entries = []
      saved = {}
      filename = undefined
    },
    registerWithRouter(router) {
      const readRouter = typeof router.access === 'function' ? router.access('readonly') : router
      const writeRouter = typeof router.access === 'function' ? router.access('readwrite') : router
      readRouter.get('/state', handle((req, res) => res.json(state())))
      writeRouter.post('/values', handle((req, res) => {
        if (!running) throw new InputError('Plugin is not running. Check Plugin Config and server logs.', 503)
        if (req.get('Origin')) {
          const expected = `${req.protocol}://${req.get('Host')}`
          if (req.get('Origin') !== expected) throw new InputError('Cross-origin writes are not allowed.', 403)
        }
        const body = req.body
        if (!isRecord(body) || Object.keys(body).length !== 2 ||
            !Object.hasOwn(body, 'path') || !Object.hasOwn(body, 'value')) throw new InputError('Send exactly path and value.')
        const entry = entries.find(item => item.path === body.path)
        if (!entry) throw new InputError('This path is not configured for editing.', 403)
        validateValue(entry, body.value)
        const updatedAt = new Date().toISOString()
        const next = { ...saved, [entry.path]: { type: entry.type, value: body.value, updatedAt } }
        persist(filename, next)
        saved = next
        try {
          publish([{ path: entry.path, value: body.value }])
        } catch (error) {
          report(error)
          return res.status(503).json({ error: 'Value saved to disk, but publishing failed. Check server logs and retry.', persisted: true })
        }
        lastError = null
        app.setPluginStatus(`Saved and published ${entry.path}.`)
        res.json(state())
      }))
    }
  }

  function publish(values) {
    app.handleMessage(plugin.id, {
      context: 'vessels.self',
      updates: [{ source: { label: plugin.id }, timestamp: new Date().toISOString(), values }]
    })
  }

  function report(error) {
    lastError = error.message
    app.error(`S2KaddData: ${error.message}`)
    app.setPluginError(error.message)
  }

  function state() {
    return {
      running, version, lastError,
      entries: entries.map(entry => {
        const current = app.getSelfPath(entry.path)
        const wrapped = isRecord(current) && Object.hasOwn(current, 'value')
        const value = wrapped ? current.value : current
        return {
          ...entry,
          current: value === undefined ? null : value,
          available: value !== undefined && value !== null,
          timestamp: wrapped ? current.timestamp ?? null : null,
          source: wrapped ? current.$source ?? null : null,
          saved: saved[entry.path] ?? null
        }
      })
    }
  }

  function handle(fn) {
    return (req, res) => {
      res.set('Cache-Control', 'no-store')
      try { return fn(req, res) } catch (error) {
        if (error instanceof InputError) {
          app.error(`S2KaddData request: ${error.message}`)
          return res.status(error.status).json({ error: error.message })
        }
        report(error)
        return res.status(500).json({ error: 'Operation failed. Check Signal K server logs; no success is confirmed.' })
      }
    }
  }

  return plugin
}
