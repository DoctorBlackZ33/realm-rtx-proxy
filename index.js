#!/usr/bin/env node
'use strict'

if (Number(process.versions.node.split('.')[0]) < 24) {
  process.stderr.write('Node.js 24 or newer is required.\n')
  process.exit(1)
}

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline/promises')
const debug = require('debug')

delete process.env.DEBUG
debug.disable()
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  console[method] = () => {}
}


// The pinned Relay's deserializer writes malformed packet bytes to disk before
// reporting a parse error. Replace that diagnostic before importing Relay;
// parse failures still follow its normal disconnect/error path.
const serializer = require('bedrock-protocol/src/transforms/serializer')
const createDeserializer = serializer.createDeserializer
serializer.createDeserializer = (...args) => {
  const deserializer = createDeserializer(...args)
  deserializer.dumpFailedBuffer = () => {}
  const parsePacketBuffer = deserializer.parsePacketBuffer.bind(deserializer)
  deserializer.parsePacketBuffer = (...packet) => {
    try {
      return parsePacketBuffer(...packet)
    } catch (error) {
      output(`packet-parse=failed reason=${redactedReason(error)}`)
      throw error
    }
  }
  return deserializer
}

const { Relay, Client } = require('bedrock-protocol')
require('./native-raknet')
const mcData = require('minecraft-data')
const { FIELDS, logAndRewriteFlag } = require('./required-flags')
const { PackRelayPlayer } = require('./relay-player')
const { realmAuthenticate } = require('bedrock-protocol/src/client/auth')
const { HttpNethernetServer } = require('./http-nethernet')
// Official MinecraftPE/1.26.62.1 discovery advertises this HTTP API base.
// The XSTS relying party remains pocket.realms.minecraft.net.
require('prismarine-realms/src/constants').bedrock.host = 'https://bedrock.frontendlegacy.realms.minecraft-services.net'
const RESPONSE_PHASES = Object.freeze({
  0: 'refused',
  1: 'send-packs',
  2: 'have-all-packs',
  3: 'completed',
  refused: 'refused',
  send_packs: 'send-packs',
  have_all_packs: 'have-all-packs',
  completed: 'completed'
})

function output (event) {
  process.stdout.write(`[realm-proxy] ${event}\n`)
}

function usage () {
  process.stdout.write(`Usage: node index.js --version <supported-codec-version> --game-version <observed-game-build> [options]

Options:
  --version <v>         Supported bedrock-protocol/minecraft-data codec version
  --game-version <v>    Observed installed Minecraft version/build (for evidence)
  --host <ip>           Private/loopback listen address (default 127.0.0.1)
  --port <port>         Listen port (default 19132)
  --mode <mode>         passthrough (default), individual, or all
  --field <field>       For individual mode: info, stack, or start-game
  --realm-id <id>       Select an accessible Realm directly; otherwise prompt
  --auth-cache <path>   Reuse only this proxy's authorized session cache
  --help                Show this help

The client and Realm account use normal Microsoft/Xbox authentication. The
proxy does not accept passwords or existing game credentials. Its default
temporary auth cache is removed at exit; an explicit session cache is retained
for controlled reconnects and must be removed when the experiment finishes.
The client entry uses authenticated HTTP NetherNet signalling and WebRTC.
Supported packet flows and pack data are forwarded unchanged; a missing
selected flag aborts the connection.\n`)
}

function parseArgs (argv) {
  const args = { host: '127.0.0.1', port: 19132, mode: 'passthrough', field: null, realmId: null, gameVersion: null, authCache: null }
  const options = new Set(['--version', '--game-version', '--host', '--port', '--mode', '--field', '--realm-id', '--auth-cache'])
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i]
    if (option === '--help') {
      args.help = true
      continue
    }
    if (!options.has(option)) throw new Error('unknown option')
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${option}`)
    const key = {
      '--version': 'version',
      '--game-version': 'gameVersion',
      '--host': 'host',
      '--port': 'port',
      '--mode': 'mode',
      '--field': 'field',
      '--realm-id': 'realmId',
      '--auth-cache': 'authCache'
    }[option]
    if (args[key] !== null && args[key] !== undefined && key !== 'host' && key !== 'port' && key !== 'mode') {
      throw new Error(`duplicate option ${option}`)
    }
    args[key] = value
  }
  return args
}

function isAllowedBindAddress (address) {
  if (net.isIP(address) === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  }
  if (address === '::1') return true
  if (net.isIP(address) === 6) return /^f[cd][0-9a-f]{2}:/i.test(address)
  return false
}


function redactedReason (reason) {
  const error = reason && typeof reason === 'object' ? reason : null
  const cause = error?.cause && typeof error.cause === 'object' ? error.cause : null
  const message = typeof reason === 'string' ? reason : [error?.message, cause?.message].filter(value => typeof value === 'string').join(' ')
  const codeValue = [error?.code, cause?.code].find(value => typeof value === 'string' && /^[A-Z0-9_.-]{1,32}$/.test(value))
  const code = codeValue || 'none'
  const type = typeof error?.name === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(error.name) ? error.name.toLowerCase() : 'event'
  const statusValue = [error?.statusCode, error?.status, cause?.statusCode, cause?.status].find(value => Number.isInteger(value) && value >= 100 && value <= 599)
  const messageStatus = /^\s*(\d{3})\b/.exec(message)
  const status = statusValue ?? (messageStatus ? Number(messageStatus[1]) : 'none')
  const text = [error?.code, cause?.code, error?.name, cause?.name, message, status].filter(value => typeof value === 'string' || typeof value === 'number').join(' ').slice(0, 512).toLowerCase()

  let category = 'unexpected'
  if (/couldn.t find any realms/.test(text)) category = 'no-accessible-realms'
  else if (/couldn.t find a realm|realm.*not found|no realm access|invalid realm selection/.test(text)) category = 'realm-selection-or-access'
  else if (/unsupported version|no data available|outdated client|outdated server/.test(text)) category = 'version-mismatch'
  else if (/enotfound|eai_again|getaddrinfo|dns/.test(text)) category = 'dns-failure'
  else if (/etimedout|timeout|timed out|deadline/.test(text)) category = 'timeout'
  else if (/advertisement/.test(text)) category = 'advertisement-failure'
  else if (/bind|socket|port/.test(text)) category = 'bind-or-socket-failure'
  else if (/signall?ing|turn auth|websocket/.test(text)) category = 'realm-signalling-failure'
  else if (/nethernet|webrtc|ice candidate/.test(text)) category = 'nethernet-transport-failure'
  else if (/auth|credential|token|login|xbox|microsoft|unauthorized|forbidden|\b401\b|\b403\b/.test(text)) category = 'authentication-failure'
  else if (/parse|deseriali[sz]e|packet violation|malformed packet/.test(text)) category = 'protocol-parse-failure'
  else if (/close|disconnect|kick/.test(text)) category = 'connection-closed'
  else if (status === 404) category = 'service-endpoint-not-found'
  else if (status >= 500 && status < 600) category = 'service-unavailable'
  else if (status !== 'none') category = 'http-failure'

  return `${category}-type=${type}-code=${code}-status=${status}`
}

function safeErrorFrames (error) {
  if (typeof error?.stack !== 'string') return []
  return error.stack.split('\n').slice(1, 13).flatMap(line => {
    const location = /(?:^|[\\/ (])([A-Za-z0-9_.-]+\.(?:[cm]?js)):(\d+):(\d+)\)?$/.exec(line.trim())
    return location ? [`${location[1]}:${location[2]}:${location[3]}`] : []
  })
}

for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, error => {
    output(`fatal=${event} reason=${redactedReason(error)}`)
    for (const frame of safeErrorFrames(error)) output(`fatal-frame=${frame}`)
    process.exit(1)
  })
}

const originalClientErrorHandler = Client.prototype.onConnectionError
Client.prototype.onConnectionError = function (error) {
  output(`upstream=client-error reason=${redactedReason(error)}`)
  return originalClientErrorHandler.call(this, error)
}

// Keep pending clients owned during auth/transport setup, and do not generate
// cache or resource-pack responses on behalf of the real Minecraft client.
Relay.prototype.openUpstreamConnection = async function (player, address) {
  const options = {
    authTitle: this.options.authTitle,
    flow: this.options.flow,
    deviceType: this.options.deviceType,
    username: player.profile.xuid,
    version: this.options.version,
    offline: false,
    realms: this.options.destination.realms,
    nethernet: this.options.destination.nethernet,
    profilesFolder: this.options.profilesFolder,
    onMsaCode: this.options.onMsaCode,
    raknetBackend: 'raknet-native',
    autoInitPlayer: false,
    conLog: () => {}
  }
  try {
    output('upstream=realm-authentication-started')
    options.version = this.options.realmGameVersion
    try {
      await realmAuthenticate(options)
    } finally {
      options.version = this.options.version
    }
    if (this._closed || player._closed) return
    output(`upstream=realm-resolved transport=${options.transport} codec-protocol=${this.options.protocolVersion}`)
    const client = new Client(options)
    client.options.skinData = player.skinData
    player.pendingUpstream = client
    this.upstreams.set(address, client)
    client.once('join', () => {
      if (this._closed || player._closed) return client.close()
      player.upstream = client
      player.pendingUpstream = null
      client.readPacket = packet => player.readUpstream(packet)
      player.flushUpQueue()
      this.emit('join', player, client)
    })
    client.on('error', error => {
      output(`upstream=connection-failed reason=${redactedReason(error)}`)
      player.disconnect('Upstream connection failed')
    })
    client.once('close', () => {
      this.upstreams.delete(address)
      if (!player._closed) player.disconnect('Upstream connection closed')
    })
    client.on('session', () => output('upstream=account-authenticated'))
    client.connect()
  } catch (error) {
    output(`upstream=setup-failed reason=${redactedReason(error)}`)
    throw error
  }
}


async function selectRealm (realms, input) {
  if (!Array.isArray(realms) || realms.length === 0) throw new Error('no accessible Realms')
  process.stdout.write('\nAccessible Realms:\n')
  for (let i = 0; i < realms.length; i++) {
    const name = typeof realms[i]?.name === 'string' ? realms[i].name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80) : 'unnamed Realm'
    process.stdout.write(`  ${i + 1}. ${name}\n`)
  }
  const answer = await input.question('Select the authorized destination Realm number: ')
  if (!/^[1-9][0-9]*$/.test(answer)) throw new Error('invalid Realm selection')
  const index = Number(answer) - 1
  if (index >= realms.length) throw new Error('invalid Realm selection')
  output('realm-selection=complete')
  return realms[index]
}

function makeDeviceCodeHandler () {
  return data => {
    let uri = 'https://www.microsoft.com/link'
    try {
      const candidate = new URL(data?.verification_uri)
      if (candidate.protocol === 'https:' && (candidate.port === '' || candidate.port === '443') && ['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(candidate.hostname)) {
        const pathname = /^[A-Za-z0-9/_-]{1,80}$/.test(candidate.pathname) ? candidate.pathname : '/link'
        uri = `https://${candidate.hostname}${pathname}`
      }
    } catch {}
    const code = typeof data?.user_code === 'string' && /^[A-Z0-9-]{4,32}$/i.test(data.user_code) ? data.user_code : null
    process.stdout.write('\nMicrosoft device sign-in is required for the authorized Realm account.\n')
    process.stdout.write(`Open ${uri} and enter ${code || '[code unavailable]'} using the account owner\'s own browser.\n`)
    process.stdout.write('No password or token is requested by this proxy.\n\n')
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  if (!args.version) throw new Error('--version is required; choose a supported protocol codec for the observed client')
  if (!args.gameVersion) throw new Error('--game-version is required; use the observed installed game version')
  if (!/^\d+(?:\.\d+){1,3}$/.test(args.version) || !/^\d+(?:\.\d+){1,3}$/.test(args.gameVersion)) throw new Error('invalid game or codec version format')
  const codecVersion = mcData.versions.bedrock.find(version => version.minecraftVersion === args.version)
  if (!codecVersion) throw new Error(`unsupported codec version in installed minecraft-data: ${args.version}`)
  if (!isAllowedBindAddress(args.host)) throw new Error('listen address must be loopback or a private IPv4/IPv6 address')
  if (!Number.isInteger(Number(args.port)) || Number(args.port) < 1 || Number(args.port) > 65535) throw new Error('invalid listen port')
  if (!['passthrough', 'individual', 'all'].includes(args.mode)) throw new Error('invalid mode')
  if (args.mode === 'individual' && !Object.hasOwn(FIELDS, args.field)) throw new Error('individual mode requires --field info|stack|start-game')
  if (args.mode !== 'individual' && args.field !== null) throw new Error('--field is valid only in individual mode')
  if (args.realmId !== null && !/^\d{1,20}$/.test(args.realmId)) throw new Error('Realm ID must be numeric')

  const ownsAuthCache = args.authCache === null
  const authCache = ownsAuthCache
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'realm-pack-proxy-auth-'))
    : path.resolve(args.authCache)
  fs.mkdirSync(authCache, { recursive: true, mode: 0o700 })
  const cleanup = () => {
    if (ownsAuthCache) {
      try { fs.rmSync(authCache, { recursive: true, force: true }) } catch {}
    }
  }
  try {
    fs.chmodSync(authCache, 0o700)
  } catch (error) {
    cleanup()
    throw error
  }
  process.once('exit', cleanup)
  const input = readline.createInterface({ input: process.stdin, output: process.stdout })
  let relay
  let shuttingDown = false

  const shutdown = async signal => {
    if (shuttingDown) return
    shuttingDown = true
    output(`shutdown=${signal}`)
    setTimeout(() => process.exit(0), 1500).unref()
    input.close()
    try { await relay?.close('Proxy shutting down') } catch {}
    cleanup()
    // Device-code polling can precede creation of an upstream Client. Closing
    // Relay alone cannot cancel those dependency-owned HTTP requests/timers.
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.stdin.once('end', () => { void shutdown('stdin-closed') })

  try {
    const realms = args.realmId
      ? { realmId: args.realmId }
      : { pickRealm: available => selectRealm(available, input) }
    relay = new Relay({
      transport: 'nethernet',
      nethernet: {
        host: args.host,
        port: Number(args.port),
        operatorKey: path.join(os.homedir(), '.realm-pack-proxy', 'operator-key.pem'),
        output,
        redact: redactedReason
      },
      host: args.host,
      port: Number(args.port),
      version: args.version,
      realmGameVersion: args.gameVersion.split('.').slice(0, 3).join('.'),
      offline: false,
      motd: { motd: 'Realm Pack Proxy', levelName: 'Authorized Realm relay' },
      relayPlayer: PackRelayPlayer,
      raknetBackend: 'raknet-native',
      enableChunkCaching: false,
      forceSingle: true,
      logging: false,
      omitParseErrors: false,
      profilesFolder: authCache,
      onMsaCode: makeDeviceCodeHandler(),
      destination: {
        realms,
        offline: false,
        nethernet: { signalling: 'services' }
      }
    })
    fs.mkdirSync(path.dirname(relay.options.nethernet.operatorKey), { recursive: true, mode: 0o700 })
    relay.transportServer = HttpNethernetServer
    // Relay's base Server and Relay both decrement clientCount on close. Leave
    // accounting to Relay's player-close listener so forceSingle remains valid
    // after a guest reconnects.
    relay.onCloseConnection = (connection, reason) => {
      const player = relay.clients[connection.address]
      if (player) player.close(reason)
    }
    relay.conLog = () => {}
    relay.deserializer.dumpFailedBuffer = () => {}

    relay.on('connect', player => {
      output('client=connected')
      const verifyLogin = player.verifyLogin
      player.verifyLogin = async envelope => {
        const verified = await verifyLogin(envelope)
        const transport = player.connection.transportIdentity
        const loginKey = verified.clientPublicKey.export({ format: 'der', type: 'spki' })
        if (!transport || !loginKey.equals(transport.publicKey) || verified.identity.XUID !== transport.xuid) {
          throw new Error('Login identity does not match authenticated HTTP transport')
        }
        return verified
      }
      const checkProtocol = player.handleClientProtocolVersion.bind(player)
      player.handleClientProtocolVersion = protocol => {
        output(`client=wire-protocol protocol=${protocol} expected=${codecVersion.version}`)
        if (protocol !== codecVersion.version) {
          output('client=rejected reason=version-mismatch')
          player.sendDisconnectStatus(protocol > codecVersion.version ? 'failed_spawn' : 'failed_client')
          return false
        }
        return checkProtocol(protocol)
      }
      const rejectLogin = player.rejectLogin.bind(player)
      player.rejectLogin = error => {
        output(`client=login-rejected reason=${redactedReason(error)}`)
        rejectLogin(error)
      }
      const observed = { info: 0, stack: 0, startGame: 0, responses: 0 }
      let countsReported = false
      const reportCounts = () => {
        if (countsReported) return
        countsReported = true
        output(`handshake-events info=${observed.info} stack=${observed.stack} start-game=${observed.startGame} pack-responses=${observed.responses}`)
      }
      player.on('login', () => output('client=authenticated'))
      player.on('join', () => output('client=protocol-handshake-complete'))
      player.on('close', () => {
        reportCounts()
        output('client=disconnected reason=connection-closed-details-redacted')
      })
      player.on('clientbound', ({ name, params }, des) => {
        if (name === 'resource_packs_info') observed.info++
        else if (name === 'resource_pack_stack') observed.stack++
        else if (name === 'start_game') observed.startGame++
        if (name === 'disconnect') output(`server=disconnected reason=${redactedReason(params?.message || params?.reason)}`)
        const field = Object.values(FIELDS).find(candidate => candidate.packet === name)
        const rewrite = args.mode === 'all' || (args.mode === 'individual' && FIELDS[args.field] === field)
        des.modified = Boolean(field && rewrite && params?.[field.property] === true)
        if (!logAndRewriteFlag(name, params, args, output)) {
          output('connection=aborted reason=required-flag-schema-missing')
          des.canceled = true
          player.disconnect('Unsupported resource pack flag schema')
          player.upstream?.close('Unsupported resource pack flag schema')
        }
      })
      player.on('serverbound', ({ name, params }) => {
        if (name === 'set_local_player_as_initialized') {
          output('client=spawned')
          reportCounts()
          return
        }
        if (name !== 'resource_pack_client_response') return
        observed.responses++
        const phase = RESPONSE_PHASES[params?.response_status] || 'unknown'
        output(`pack-response phase=${phase}`)
      })
    })
    relay.on('join', () => output('realm=protocol-handshake-complete'))
    relay.on('error', error => output(`proxy=error reason=${redactedReason(error)}`))

    await relay.listen()
    const response = await fetch(`http://${net.isIP(args.host) === 6 ? `[${args.host}]` : args.host}:${args.port}/v1/join`, { signal: AbortSignal.timeout(2000) })
    const advertisement = await response.json()
    if (response.status !== 200 || advertisement.protocol !== codecVersion.version || advertisement.version !== args.version) {
      throw new Error('HTTP NetherNet capability advertisement does not match selected codec')
    }
    output(`http-capability=verified protocol=${advertisement.protocol} codec-version=${advertisement.version} port=${args.port}`)
    output(`listening=${args.host}:${args.port} game-version=${args.gameVersion} codec-version=${args.version} protocol=${codecVersion.version} mode=${args.mode}${args.field ? ` field=${args.field}` : ''}`)
  } catch (error) {
    output(`startup=failed reason=${redactedReason(error)}`)
    try { await relay?.close('Startup failed') } catch {}
    input.close()
    cleanup()
    process.exit(1)
  }
}

main().catch(error => {
  output(`startup=failed reason=${redactedReason(error)}`)
  usage()
  process.exitCode = 1
})
