'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const JWT = require('jsonwebtoken')
const { Server } = require('nethernet')
const { SignalStructure, SignalType } = require('nethernet/src/signalling')
const { attachIdentity, extractFingerprints, fingerprintsPayload } = require('nethernet/src/identity')
const { verifyOidcToken } = require('bedrock-protocol/src/handshake/oidc')

const MAX_PRE_OPEN_FRAMES = 64
const MAX_PRE_OPEN_BYTES = 256 * 1024

function operatorKey (filename) {
  try {
    return crypto.createPrivateKey(fs.readFileSync(filename))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
    fs.writeFileSync(filename, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
    return privateKey
  }
}

async function verifyOffer (sdp, version) {
  const lines = sdp.split(/\r?\n/).filter(line => line.startsWith('a=identity:'))
  if (lines.length !== 1) throw new Error('Missing or duplicate offer identity')
  const identity = JSON.parse(Buffer.from(lines[0].slice(11), 'base64').toString('utf8'))
  if (identity.idp?.protocol !== 'default') throw new Error('Unsupported identity protocol')
  const assertion = JSON.parse(identity.assertion)
  const token = await verifyOidcToken(assertion.token, version)
  if (!Number.isInteger(token.exp) || token.exp <= Date.now() / 1000) throw new Error('Expired offer identity')
  const key = typeof token.cpk === 'object'
    ? crypto.createPublicKey({ key: token.cpk, format: 'jwk' })
    : crypto.createPublicKey({ key: Buffer.from(token.cpk, 'base64'), type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp384r1') throw new Error('Unsupported offer identity key')
  const parts = assertion.fingerprints?.split('.')
  if (parts?.length !== 3 || parts[1] !== '' || JSON.parse(Buffer.from(parts[0], 'base64url')).alg !== 'ES384') throw new Error('Invalid fingerprint assertion')
  const fingerprints = extractFingerprints(sdp)
  if (!fingerprints.length) throw new Error('Missing offer fingerprints')
  const payload = Buffer.from(fingerprintsPayload(fingerprints)).toString('base64url')
  if (!crypto.verify('sha384', Buffer.from(`${parts[0]}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))) {
    throw new Error('Invalid fingerprint signature')
  }
  const xuid = token.xid || token.XUID || token.xuid
  if (typeof xuid !== 'string' || !/^[1-9][0-9]{0,19}$/.test(xuid)) throw new Error('Missing authenticated offer identity')
  return {
    sdp: sdp.split(/\r?\n/).filter(line => !line.startsWith('a=identity:')).join('\r\n'),
    publicKey: key.export({ format: 'der', type: 'spki' }),
    xuid
  }
}

// HTTP contract and server cpk JWK: Mojang/bedrock-protocol-docs@f8d1496,
// additional_docs/NetherNetOnboardingGuide.md. Latest client cpk DER vs server
// JWK is also explicit in df-mc/go-nethernet@4c06b55/identity.go.
// Reuse NetherNet peer negotiation, framing and channel lifecycle.
class HttpNethernetServer {
  constructor (options, server) {
    this.server = server
    this.options = options
    this.onOpenConnection = () => {}
    this.onCloseConnection = () => {}
    this.onEncapsulated = () => {}
    this.onError = () => {}
    this.onClose = () => {}
    this.updateAdvertisement = () => {}
    this.nethernet = new Server({ webrtcBackend: 'werift', acceptTimeoutMs: 60000 })
    this.identities = new Map()
    this.receiveStates = new Map()
    this.nethernet.on('error', error => this.onError(error))
    this.nethernet.on('openConnection', client => {
      client.transportIdentity = this.identities.get(client.address)
      client.sendReliable = buffer => client.send(buffer)
      this.onOpenConnection(client)
      if (client.closed) return
      const state = this.receiveStates.get(client.address)
      if (state) {
        this.options.output(`transport=pre-open-flush frames=${state.frames.length} bytes=${state.bytes}`)
        // Keep buffering until registration and the ordered flush both finish.
        for (const buffer of state.frames) {
          if (client.closed) break
          this.onEncapsulated(buffer, client.address)
        }
        state.frames.length = 0
        state.bytes = 0
        state.ready = true
      } else {
        this.receiveStates.set(client.address, { frames: [], bytes: 0, ready: true })
      }
    })
    this.nethernet.on('closeConnection', address => {
      this.identities.delete(address)
      const state = this.receiveStates.get(address)
      if (state) state.frames.length = 0
      this.receiveStates.delete(address)
      this.onCloseConnection({ address })
    })
    this.nethernet.on('encapsulated', (buffer, address) => {
      const client = this.nethernet.connections.get(address)
      if (!client || client.closed) return
      let state = this.receiveStates.get(address)
      if (state?.ready) {
        this.onEncapsulated(buffer, address)
        return
      }
      // NetherNet receives reliable messages before both channels announce open.
      // Bedrock must register its Player synchronously before receiving any frame.
      if (!state) {
        state = { frames: [], bytes: 0, ready: false }
        this.receiveStates.set(address, state)
      }
      if (state.frames.length >= MAX_PRE_OPEN_FRAMES || state.bytes + buffer.length > MAX_PRE_OPEN_BYTES) {
        this.options.output('transport=pre-open-buffer-limit')
        client.close('preopenbufferlimit')
        return
      }
      state.frames.push(buffer)
      state.bytes += buffer.length
    })
    this.key = operatorKey(options.operatorKey)
    const publicKey = crypto.createPublicKey(this.key).export({ format: 'jwk' })
    this.identity = {
      privateKey: this.key,
      domain: 'localhost',
      token: JWT.sign({ cpk: publicKey, iss: 'Local Realm Pack Proxy' }, this.key, { algorithm: 'ES384', expiresIn: '30d' })
    }
    options.output(`operator-key-sha256=${crypto.createHash('sha256').update(JSON.stringify(publicKey)).digest('hex')}`)
  }

  advertisement () {
    return { name: 'Realm Pack Proxy', protocol: this.server.options.protocolVersion, version: this.server.options.version, level: 'Authorized Realm relay', players: this.server.clientCount, maxPlayers: 1, gameType: 0 }
  }

  async request (request, response) {
    if ((request.method === 'GET' || request.method === 'HEAD') && /^\/v1\/join\/?$/.test(request.url)) {
      this.options.output('http=capability-request')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(this.advertisement()))
      return
    }
    const match = /^\/v1\/join\/(\d{1,20})$/.exec(request.url)
    if (request.method !== 'POST' || !match || BigInt(match[1]) > 0xffffffffffffffffn) {
      response.writeHead(404).end()
      return
    }
    this.options.output('http=join-offer-received')
    if (this.pending || this.nethernet.connections.size > 0) {
      response.writeHead(503).end()
      request.resume()
      return
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/sdp') {
      response.writeHead(415).end()
      request.resume()
      return
    }
    this.pending = true
    try {
      await this.negotiate(request, response, BigInt(match[1]))
    } finally {
      this.pending = false
    }
  }

  async negotiate (request, response, id) {
    const chunks = []
    let length = 0
    for await (const chunk of request) {
      length += chunk.length
      if (length > 256 * 1024) {
        response.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    let offer
    try {
      offer = await verifyOffer(Buffer.concat(chunks).toString('utf8'), this.server.options.version)
    } catch (error) {
      this.options.output(`http=offer-identity-rejected reason=${this.options.redact(error)}`)
      response.writeHead(401).end()
      return
    }
    this.options.output('http=offer-identity-verified')
    const signal = new SignalStructure(SignalType.ConnectRequest, id, offer.sdp, id)
    this.identities.set(signal.connectionId, offer)
    let answered = false
    const closed = () => {
      if (response.writableFinished) return
      this.nethernet.connections.get(id)?.close()
      this.identities.delete(id)
    }
    response.once('close', closed)
    await this.nethernet.handleOffer(signal, result => {
      if (answered || result.type === SignalType.CandidateAdd) return
      answered = true
      if (result.type === SignalType.ConnectError) {
        this.identities.delete(id)
        this.nethernet.connections.get(id)?.close()
        this.options.output(`http=negotiation-failed code=${Number(result.data)}`)
        response.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(result.data))
      } else if (result.type === SignalType.ConnectResponse) {
        const answer = attachIdentity(result.data, this.identity)
        response.writeHead(200, { 'Content-Type': 'application/sdp' }).end(answer)
        this.options.output('http=signed-answer-sent')
      }
    })
  }

  async listen () {
    this.http = http.createServer((request, response) => {
      this.request(request, response).catch(error => {
        this.options.output(`http=request-failed reason=${this.options.redact(error)}`)
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    this.http.requestTimeout = 20000
    this.http.headersTimeout = 10000
    await new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.options.port, this.options.host, resolve)
    })
    this.http.on('error', error => this.onError(error))
  }

  close () {
    this.nethernet.close()
    this.http?.close()
    this.http?.closeAllConnections()
  }
}

module.exports = { HttpNethernetServer }
