'use strict'

const { Player } = require('bedrock-protocol/src/serverPlayer')

// Terminate only the two login/encryption handshakes. Forward the original
// decoded packet bytes thereafter, except a packet whose required flag changed.
// The stock RelayPlayer also rewrites cache responses and reorders early chunks.
class PackRelayPlayer extends Player {
  constructor (server, connection) {
    super(server, connection)
    this.startRelaying = false
    this.upQ = []
    this.once('join', () => { this.startRelaying = true })
  }

  readUpstream (packet) {
    if (this._closed) return
    try {
      const des = this.server.deserializer.parsePacketBuffer(packet)
      this._processOutbound(des.data.name, des.data.params)
      if (des.data.name === 'play_status' && des.data.params.status === 'login_success') return
      this.emit('clientbound', des.data, des)
      if (des.canceled) return
      const outgoing = des.modified
        ? this.server.serializer.createPacketBuffer(des.data)
        : packet
      this.sendBuffer(outgoing)
    } catch (error) {
      this.server.emit('error', error)
      this.disconnect('Unsupported upstream packet schema')
      this.upstream?.close()
    }
  }

  readPacket (packet) {
    if (!this.startRelaying) return super.readPacket(packet)
    if (this._closed) return
    if (!this.upstream) {
      this.upQ.push(packet)
      return
    }
    try {
      const des = this.server.deserializer.parsePacketBuffer(packet)
      this.emit('serverbound', des.data, des)
      if (!des.canceled) this.upstream.sendBuffer(packet)
    } catch (error) {
      this.server.emit('error', error)
      this.disconnect('Unsupported client packet schema')
      this.upstream.close()
    }
  }

  flushUpQueue () {
    const queued = this.upQ
    this.upQ = []
    for (const packet of queued) this.readPacket(packet)
  }

  close (reason) {
    this.pendingUpstream?.close()
    this.upstream?.close()
    this.upQ = []
    super.close(reason)
  }
}

module.exports = { PackRelayPlayer }
