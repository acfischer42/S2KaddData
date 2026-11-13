'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const createPlugin = require('../index')

const port = Number(process.env.PORT || 18746)
const routes = new Map()
const data = {}
const plugin = createPlugin({
  getDataDirPath: () => path.join(__dirname, '../.preview-data'),
  getSelfPath: key => data[key],
  error: console.error,
  setPluginError: console.error,
  setPluginStatus: console.log,
  handleMessage(source, delta) {
    for (const update of delta.updates) for (const item of update.values) {
      data[item.path] = { value: item.value, timestamp: update.timestamp, $source: source }
    }
  }
})
const router = {
  access() { return router },
  get(route, handler) { routes.set(`GET ${route}`, handler) },
  post(route, handler) { routes.set(`POST ${route}`, handler) }
}
plugin.registerWithRouter(router)
plugin.start({ entries: [
  { path: 'tanks.fuel.0.currentLevel', nickname: 'Fuel tank', group: 'Tanks', type: 'number', display: 'percent' },
  { path: 'tanks.fuel.0.name', nickname: 'Tank name', group: 'Tanks', type: 'string' },
  { path: 'electrical.switches.manual.state', nickname: 'Manual switch', type: 'boolean' }
] })
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
])
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const file = files.get(pathname)
  if (req.method === 'GET' && file) {
    res.writeHead(200, { 'Content-Type': file[1] })
    fs.createReadStream(path.join(__dirname, '../public', file[0])).pipe(res)
    return
  }
  const route = pathname.replace(/^\/plugins\/signalk-s2k-add-data/, '')
  const handler = routes.get(`${req.method} ${route}`)
  if (!handler) { res.writeHead(404); res.end('Not found'); return }
  let body = ''
  try {
    for await (const chunk of req) {
      body += chunk
      if (body.length > 16384) { res.writeHead(413); res.end('Too large'); return }
    }
    req.body = body ? JSON.parse(body) : undefined
  } catch (error) {
    console.error(error.message)
    res.writeHead(400); res.end('Invalid JSON'); return
  }
  req.protocol = 'http'
  req.get = name => req.headers[name.toLowerCase()]
  res.set = (name, value) => { res.setHeader(name, value); return res }
  res.status = code => { res.statusCode = code; return res }
  res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return res }
  handler(req, res)
})
server.on('error', error => { console.error(error); process.exitCode = 1 })
server.listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}/ (loopback only; mocked Signal K, no boat connection)`))
function stop() { plugin.stop(); server.close() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
