'use strict'

const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const root = path.dirname(require.resolve('raknet-native/package.json'))
const entry = require.resolve('raknet-native')
const api = require.resolve('raknet-native/lib/RakNet')
const helper = require('raknet-native/helpers/buildPath')
const primary = helper.getPath()
const fallback = helper.getFallbackPath()
const binary = primary && fs.existsSync(primary) ? primary : fallback

if (!binary || !binary.startsWith(path.join(root, 'prebuilds') + path.sep)) {
  throw new Error('No installed native RakNet prebuild for this platform')
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if ((request === './binding' && parent?.filename === entry) ||
      (request === '../binding' && parent?.filename === api)) {
    return originalLoad.call(this, binary, parent, isMain)
  }
  return originalLoad.call(this, request, parent, isMain)
}

try {
  module.exports = require('raknet-native')
} finally {
  Module._load = originalLoad
}
