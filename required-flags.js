'use strict'

const FIELDS = Object.freeze({
  info: Object.freeze({ packet: 'resource_packs_info', property: 'must_accept' }),
  stack: Object.freeze({ packet: 'resource_pack_stack', property: 'must_accept' }),
  'start-game': Object.freeze({ packet: 'start_game', property: 'is_texturepacks_required' })
})

function safePackUuid (value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) return 'redacted'
  return value.toLowerCase()
}

function safePackVersion (value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:\.\d+){0,3}(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(value)) return 'redacted'
  return value
}

function summarizePacks (packs) {
  if (!Array.isArray(packs)) return 'unavailable'
  if (packs.length === 0) return 'none'
  const summarized = packs.slice(0, 64).map(pack => `${safePackUuid(pack?.uuid)}@${safePackVersion(pack?.version)}`).join(',')
  return packs.length > 64 ? `${summarized},+${packs.length - 64}-more` : summarized
}

function rewriteRequiredFlag (packet, params, mode, selectedField) {
  const field = Object.values(FIELDS).find(candidate => candidate.packet === packet)
  if (!field) return null

  const original = params?.[field.property]
  const shouldRewrite = mode === 'all' || (mode === 'individual' && FIELDS[selectedField] === field)
  if (shouldRewrite && typeof original !== 'boolean') {
    return { packet, property: field.property, original, effective: original, supported: false }
  }

  if (shouldRewrite) params[field.property] = false
  return {
    packet,
    property: field.property,
    original,
    effective: shouldRewrite ? false : original,
    supported: true
  }
}

function logAndRewriteFlag (packet, params, args, output) {
  const result = rewriteRequiredFlag(packet, params, args.mode, args.field)
  if (!result) return true

  if (!result.supported) {
    output(`packet-schema-error packet=${result.packet} field=${result.property}`)
    return false
  }

  const suffix = packet === 'resource_packs_info'
    ? ` packs=${summarizePacks(params?.texture_packs)}`
    : packet === 'resource_pack_stack'
      ? ` packs=${summarizePacks(params?.resource_packs)}`
      : ''
  const required = typeof result.original === 'boolean' ? result.original : 'unknown'
  const effective = typeof result.effective === 'boolean' ? result.effective : 'unknown'
  output(`packet=${packet} required=${required} effective=${effective}${suffix}`)
  return true
}

module.exports = { FIELDS, logAndRewriteFlag }
