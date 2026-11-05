#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const appDirectory = __dirname
const configPath = path.join(appDirectory, 'config.json')
const indexPath = path.join(appDirectory, 'index.js')
const defaults = Object.freeze({
  version: '1.26.60',
  gameVersion: '1.26.62.1',
  host: '127.0.0.1',
  port: 19132,
  mode: 'all'
})
const configOptions = Object.freeze([
  ['version', '--version'],
  ['gameVersion', '--game-version'],
  ['host', '--host'],
  ['port', '--port'],
  ['mode', '--mode']
])
const optionToConfigKey = new Map(configOptions.map(([key, option]) => [option, key]))

function fail (message) {
  process.stderr.write(`[realm-rtx-proxy] ${message}\n`)
  process.exitCode = 1
}

function readConfig () {
  let text
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch (error) {
    fail(error.code === 'ENOENT'
      ? 'config.json was not found beside app.js.'
      : 'Could not read config.json beside app.js.')
    return null
  }

  let config
  try {
    config = JSON.parse(text)
  } catch {
    fail('config.json is not valid JSON.')
    return null
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail('config.json must contain a JSON object.')
    return null
  }

  const knownKeys = new Set(configOptions.map(([key]) => key))
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) {
      fail(`config.json contains an unsupported setting: ${key}`)
      return null
    }
    const value = config[key]
    const validType = key === 'port'
      ? typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
      : typeof value === 'string'
    if (!validType) {
      fail(`config.json setting ${key} has an invalid type.`)
      return null
    }
  }
  return { ...defaults, ...config }
}

function buildArguments (config, cliArguments) {
  const overriddenKeys = new Set()
  const settings = { ...config }

  for (let i = 0; i < cliArguments.length; i++) {
    const key = optionToConfigKey.get(cliArguments[i])
    if (!key) continue
    overriddenKeys.add(key)
    const value = cliArguments[i + 1]
    if (value !== undefined && !value.startsWith('--')) settings[key] = value
  }

  const args = []
  for (const [key, option] of configOptions) {
    if (!overriddenKeys.has(key)) args.push(option, String(config[key]))
  }
  args.push('--auth-cache', path.join(os.homedir(), '.realm-pack-proxy', 'auth'))
  args.push(...cliArguments)
  return { args, settings }
}

function showStartupInstructions (settings) {
  const host = String(settings.host)
  const port = String(settings.port)
  const address = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  process.stdout.write(
    `Connect Minecraft Bedrock to ${address}. If the proxy terminal requests Microsoft device-code sign-in, follow its instructions there; the proxy does not ask for your password or use the game's sign-in session.\n` +
    'Warning: proxy authorization/session data is kept in your private home directory at ~/.realm-pack-proxy/auth. Keep this directory private and do not share it.\n\n'
  )
}

function runProxy (cliArguments) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    fail('Node.js 24 or newer is required.')
    return
  }

  // Let the existing entry point own its full help output and parsing behavior.
  if (cliArguments.includes('--help')) {
    startChild(cliArguments)
    return
  }
  if (cliArguments.includes('--auth-cache')) {
    fail('The standalone app manages its persistent proxy authorization cache; remove --auth-cache.')
    return
  }

  const config = readConfig()
  if (!config) return
  const { args, settings } = buildArguments(config, cliArguments)
  showStartupInstructions(settings)
  startChild(args)
}

function startChild (args) {
  let child
  try {
    child = spawn(process.execPath, [indexPath, ...args], {
      cwd: appDirectory,
      stdio: 'inherit'
    })
  } catch {
    fail('Could not start the proxy process.')
    return
  }

  const signals = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP']
  let pendingSignal = null
  let childSpawnFailed = false
  const forwardSignal = signal => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.pid === undefined) {
      pendingSignal = signal
      return
    }
    try { child.kill(signal) } catch {}
  }
  const signalHandlers = new Map()
  for (const signal of signals) {
    const handler = () => forwardSignal(signal)
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }

  child.once('spawn', () => {
    if (pendingSignal !== null) {
      const signal = pendingSignal
      pendingSignal = null
      forwardSignal(signal)
    }
  })
  child.once('error', error => {
    if (child.pid === undefined) childSpawnFailed = true
    const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? ` (${error.code})`
      : ''
    process.stderr.write(`[realm-rtx-proxy] Could not start the proxy process${code}.\n`)
  })
  child.once('close', (code, signal) => {
    for (const [name, handler] of signalHandlers) process.off(name, handler)
    if (childSpawnFailed) {
      process.exitCode = 1
      return
    }
    if (code !== null) {
      process.exitCode = code
      return
    }
    const signalNumber = signal && os.constants.signals[signal]
    process.exitCode = signalNumber ? 128 + signalNumber : 1
  })
}

runProxy(process.argv.slice(2))
