'use strict'

const fs = require('node:fs')
const path = require('node:path')

class InputError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validatePath(value) {
  if (typeof value !== 'string' || value.length > 256 ||
      !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value) ||
      value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)) ||
      value.startsWith('vessels.')) {
    throw new InputError('Use a dotted path relative to vessels.self, without reserved segments.')
  }
}

function validateValue(entry, value) {
  if (typeof value !== entry.type ||
      (entry.type === 'number' && !Number.isFinite(value))) {
    throw new InputError(`${entry.path} requires a finite number, text, or boolean matching its configured type.`)
  }
  if (entry.type === 'string' && value.length > 4096) throw new InputError('Text is limited to 4096 characters.')
  if (entry.type === 'number') {
    if (entry.minimum !== undefined && value < entry.minimum) throw new InputError(`Minimum is ${entry.minimum} in Signal K units.`)
    if (entry.maximum !== undefined && value > entry.maximum) throw new InputError(`Maximum is ${entry.maximum} in Signal K units.`)
    if (entry.display === 'percent' && (value < 0 || value > 1)) throw new InputError('Percentage values must be ratios between 0 and 1.')
  }
}

function configure(options = {}) {
  if (!isRecord(options) || !Array.isArray(options.entries ?? [])) throw new InputError('Configure an entries list.')
  const entries = options.entries ?? []
  const seen = new Set()
  return entries.map(item => {
    if (!isRecord(item)) throw new InputError('Each entry must be an object.')
    validatePath(item.path)
    if (seen.has(item.path)) throw new InputError(`Duplicate path: ${item.path}`)
    if ([...seen].some(other => other.startsWith(`${item.path}.`) || item.path.startsWith(`${other}.`))) {
      throw new InputError(`Configured paths cannot contain each other: ${item.path}`)
    }
    seen.add(item.path)
    if (!['number', 'string', 'boolean'].includes(item.type)) throw new InputError(`Choose a type for ${item.path}.`)
    if (item.nickname !== undefined && (typeof item.nickname !== 'string' || item.nickname.length > 120)) throw new InputError('Nicknames must be text up to 120 characters.')
    const display = item.display ?? 'native'
    if (!['native', 'percent'].includes(display) || (display === 'percent' && item.type !== 'number')) throw new InputError('Percentage display is only valid for numbers.')
    for (const bound of ['minimum', 'maximum']) {
      if (item[bound] !== undefined && (item.type !== 'number' || !Number.isFinite(item[bound]))) throw new InputError('Bounds must be finite numbers on numeric entries.')
    }
    if (item.minimum !== undefined && item.maximum !== undefined && item.minimum > item.maximum) throw new InputError('Minimum must not exceed maximum.')
    return { path: item.path, nickname: item.nickname?.trim() || item.path.split('.').at(-1), type: item.type, display, minimum: item.minimum, maximum: item.maximum }
  })
}

function load(filename) {
  let text
  try {
    text = fs.readFileSync(filename, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  const data = JSON.parse(text)
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.values)) throw new Error('Unsupported or invalid saved-values file.')
  for (const [key, record] of Object.entries(data.values)) {
    validatePath(key)
    if (!isRecord(record) || !['number', 'string', 'boolean'].includes(record.type) ||
        typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error(`Invalid saved record: ${key}`)
    validateValue({ path: key, type: record.type }, record.value)
  }
  return data.values
}

function persist(filename, values) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.tmp`
  try {
    const fd = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ version: 1, values }, null, 2)}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, filename)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch (cleanup) {
      if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Saving and temporary-file cleanup failed.')
    }
    throw error
  }
}

module.exports = { InputError, configure, isRecord, load, persist, validateValue }
