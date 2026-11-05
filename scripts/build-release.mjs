#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const NODE_VERSION = '24.22.2'
const NODE_DIST_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`
const MAX_RELEASE_ASSET_BYTES = 2_000_000_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FILES = [
  'index.js',
  'http-nethernet.js',
  'native-raknet.js',
  'relay-player.js',
  'required-flags.js',
  'app.js',
  'config.json',
  'Start-Proxy.bat',
  'start-proxy.sh',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'AI-DISCLOSURE.md',
  'THIRD-PARTY-NOTICES.md'
]

const PLATFORMS = {
  'linux-x64': {
    nodeArchive: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
    archiveExtension: 'tar.gz',
    nativePlatform: 'linux',
    runtimeExecutable: 'node',
    runtimeMember: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    licenseMember: `node-v${NODE_VERSION}-linux-x64/LICENSE`
  },
  'win-x64': {
    nodeArchive: `node-v${NODE_VERSION}-win-x64.zip`,
    archiveExtension: 'zip',
    nativePlatform: 'win32',
    runtimeExecutable: 'node.exe',
    runtimeMember: `node-v${NODE_VERSION}-win-x64/node.exe`,
    licenseMember: `node-v${NODE_VERSION}-win-x64/LICENSE`
  }
}

function usage() {
  return 'Usage: node scripts/build-release.mjs [--platform linux-x64|win-x64|all]'
}

function parsePlatform(args) {
  let selected = 'all'
  let explicit = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      console.log(usage())
      process.exit(0)
    }

    let value
    if (argument === '--platform') {
      value = args[index + 1]
      index += 1
      if (!value || value.startsWith('--')) {
        throw new Error(`--platform requires a value.\n${usage()}`)
      }
    } else if (argument.startsWith('--platform=')) {
      value = argument.slice('--platform='.length)
    } else {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`)
    }

    if (explicit) throw new Error(`--platform may only be specified once.\n${usage()}`)
    if (value !== 'all' && !Object.hasOwn(PLATFORMS, value)) {
      throw new Error(`Unsupported platform: ${value}\n${usage()}`)
    }

    selected = value
    explicit = true
  }

  return selected === 'all' ? Object.keys(PLATFORMS) : [selected]
}

function requireCommand(command, args, purpose) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  if (result.error || result.status !== 0) {
    throw new Error(`Required command '${command}' is unavailable for ${purpose}. Install it and retry.`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw new Error(`Could not run '${command}': ${result.error.message}`)
  if (result.status !== 0) {
    const status = result.status === null ? `signal ${result.signal}` : `exit status ${result.status}`
    throw new Error(`'${command}' failed with ${status}.`)
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function fetchResponse(url, label) {
  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(`Unable to fetch ${label} from nodejs.org: ${error.message}`)
  }

  if (!response.ok) throw new Error(`Unable to fetch ${label}: HTTP ${response.status}.`)
  const finalUrl = new URL(response.url)
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'nodejs.org') {
    throw new Error(`Refusing unexpected download host for ${label}.`)
  }
  return response
}

async function fetchChecksums() {
  const url = `${NODE_DIST_BASE}/SHASUMS256.txt`
  const response = await fetchResponse(url, 'official Node.js SHA256SUMS')
  const text = await response.text()
  if (!text || Buffer.byteLength(text) > 1_048_576) {
    throw new Error('The official Node.js SHA256SUMS file was empty or unexpectedly large.')
  }
  return text
}

function officialChecksum(checksumText, filename) {
  const matches = []
  for (const line of checksumText.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && match[2] === filename) matches.push(match[1].toLowerCase())
  }
  if (matches.length !== 1) {
    throw new Error(`Official SHA256SUMS did not contain exactly one checksum for ${filename}.`)
  }
  return matches[0]
}

async function tryVerifiedCacheFile(candidate, workspaceCopy, expectedChecksum) {
  try {
    const candidateStat = await fs.lstat(candidate)
    if (!candidateStat.isFile()) return false
    await fs.copyFile(candidate, workspaceCopy, fsConstants.COPYFILE_EXCL)
    const copiedChecksum = await sha256File(workspaceCopy)
    if (copiedChecksum === expectedChecksum) return true
  } catch {
    // A cache miss or an unreadable cache entry is not a release blocker.
  }
  await fs.rm(workspaceCopy, { force: true })
  return false
}

async function cacheVerifiedArchive(source, cacheFile, expectedChecksum) {
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 })
    await fs.copyFile(source, cacheFile, fsConstants.COPYFILE_EXCL)
    if (await sha256File(cacheFile) !== expectedChecksum) {
      await fs.rm(cacheFile, { force: true })
    }
  } catch {
    // Caching is optional; the already verified workspace copy remains usable.
  }
}

async function getVerifiedArchive(platform, descriptor, checksumText, workspace) {
  const checksum = officialChecksum(checksumText, descriptor.nodeArchive)
  const workspaceArchive = path.join(workspace, descriptor.nodeArchive)
  const cacheRoot = path.resolve(
    process.env.REALM_RTX_PROXY_CACHE_DIR ||
      path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'realm-rtx-proxy')
  )
  const cacheFile = path.join(
    cacheRoot,
    `node-v${NODE_VERSION}`,
    `${descriptor.nodeArchive}.${checksum}`
  )
  const candidates = [cacheFile]
  if (platform === 'win-x64' && process.env.REALM_RTX_PROXY_WINDOWS_NODE_ARCHIVE) {
    candidates.push(path.resolve(process.env.REALM_RTX_PROXY_WINDOWS_NODE_ARCHIVE))
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateCopy = index === 0
      ? workspaceArchive
      : path.join(workspace, `cached-${index}-${descriptor.nodeArchive}`)
    if (await tryVerifiedCacheFile(candidates[index], candidateCopy, checksum)) {
      await cacheVerifiedArchive(candidateCopy, cacheFile, checksum)
      return { archivePath: candidateCopy, checksum }
    }
  }

  const url = `${NODE_DIST_BASE}/${descriptor.nodeArchive}`
  const response = await fetchResponse(url, descriptor.nodeArchive)
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(workspaceArchive, { flags: 'wx', mode: 0o600 })
    )
  } catch (error) {
    await fs.rm(workspaceArchive, { force: true })
    throw new Error(`Unable to download ${descriptor.nodeArchive}: ${error.message}`)
  }

  const downloadedChecksum = await sha256File(workspaceArchive)
  if (downloadedChecksum !== checksum) {
    await fs.rm(workspaceArchive, { force: true })
    throw new Error(`SHA-256 verification failed for ${descriptor.nodeArchive}; refusing to extract it.`)
  }
  await cacheVerifiedArchive(workspaceArchive, cacheFile, checksum)
  return { archivePath: workspaceArchive, checksum }
}

async function installCleanDependencies(stageDirectory, workspace) {
  const nodeDirectory = path.dirname(process.execPath)
  const npmCli = path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  try {
    await fs.access(npmCli)
  } catch {
    throw new Error('The Node.js 24 npm CLI was not found beside the builder runtime.')
  }

  const userConfig = path.join(workspace, '.npm-userconfig')
  const globalConfig = path.join(workspace, '.npm-globalconfig')
  await fs.writeFile(userConfig, '', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 })
  const environment = {
    ...process.env,
    CI: 'true',
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig
  }
  run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--omit=dev'], {
    cwd: stageDirectory,
    env: environment
  })
}

async function copyAllowlistedSources(destination) {
  await fs.mkdir(destination, { recursive: true })
  for (const filename of SOURCE_FILES) {
    const source = path.join(ROOT, filename)
    let sourceStat
    try {
      sourceStat = await fs.lstat(source)
    } catch {
      throw new Error(`Required release source file is missing: ${filename}`)
    }
    if (!sourceStat.isFile()) throw new Error(`Release source must be a regular file: ${filename}`)
    await fs.copyFile(source, path.join(destination, filename))
  }
}

async function assertNativeBinary(binaryPath, platform, directoryName) {
  const handle = await fs.open(binaryPath, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (platform === 'linux') {
      if (bytesRead < 20 || header[0] !== 0x7f || header[1] !== 0x45 ||
          header[2] !== 0x4c || header[3] !== 0x46 || header[4] !== 2 ||
          header[5] !== 1 || header.readUInt16LE(18) !== 62) {
        throw new Error(`Native RakNet prebuild ${directoryName} is not a Linux x64 binary.`)
      }
      return
    }

    if (bytesRead < 64 || header[0] !== 0x4d || header[1] !== 0x5a) {
      throw new Error(`Native RakNet prebuild ${directoryName} is not a Windows x64 binary.`)
    }
    const peOffset = header.readUInt32LE(0x3c)
    const stat = await handle.stat()
    if (peOffset > 1_048_576 || peOffset + 6 > stat.size) {
      throw new Error(`Native RakNet prebuild ${directoryName} has an invalid Windows header.`)
    }
    const peHeader = Buffer.alloc(6)
    const result = await handle.read(peHeader, 0, peHeader.length, peOffset)
    if (result.bytesRead !== peHeader.length || peHeader.toString('ascii', 0, 4) !== 'PE\0\0' ||
        peHeader.readUInt16LE(4) !== 0x8664) {
      throw new Error(`Native RakNet prebuild ${directoryName} is not a Windows x64 binary.`)
    }
  } finally {
    await handle.close()
  }
}

async function validateNativePrebuilds(appDirectory, requestedPlatforms) {
  const prebuildRoot = path.join(appDirectory, 'node_modules', 'raknet-native', 'prebuilds')
  let entries
  try {
    entries = await fs.readdir(prebuildRoot, { withFileTypes: true })
  } catch {
    throw new Error('The locked raknet-native dependency did not provide its prebuilt binaries.')
  }

  for (const platform of requestedPlatforms) {
    const descriptor = PLATFORMS[platform]
    const matches = entries.filter(entry => {
      if (!entry.isDirectory()) return false
      const parts = entry.name.split('-')
      return parts[0] === descriptor.nativePlatform && parts.at(-1) === 'x64'
    })
    let validated = 0
    for (const entry of matches) {
      const binaryPath = path.join(prebuildRoot, entry.name, 'node-raknet.node')
      let binaryStat
      try {
        binaryStat = await fs.lstat(binaryPath)
      } catch {
        continue
      }
      if (!binaryStat.isFile()) continue
      await assertNativeBinary(binaryPath, descriptor.nativePlatform, entry.name)
      validated += 1
    }
    if (validated === 0) {
      throw new Error(`The clean lockfile install has no ${descriptor.nativePlatform} x64 RakNet prebuild for ${platform}.`)
    }
  }
}

async function extractNodeRuntime(platform, descriptor, archivePath, workspace) {
  const extractionDirectory = path.join(workspace, `${platform}-node-runtime`)
  await fs.mkdir(extractionDirectory)

  if (platform === 'linux-x64') {
    run('tar', [
      '--extract', '--xz', '--file', archivePath,
      '--directory', extractionDirectory,
      '--strip-components=1', '--no-same-owner',
      descriptor.runtimeMember, descriptor.licenseMember
    ])
  } else {
    run('unzip', [
      '-qq', '-o', '-d', extractionDirectory,
      archivePath, descriptor.runtimeMember, descriptor.licenseMember
    ])
  }

  const extractedRuntimeMember = platform === 'linux-x64'
    ? descriptor.runtimeMember.replace(/^node-v[^/]+\//, '')
    : descriptor.runtimeMember
  const extractedLicenseMember = platform === 'linux-x64'
    ? descriptor.licenseMember.replace(/^node-v[^/]+\//, '')
    : descriptor.licenseMember
  const extractedRuntime = path.join(extractionDirectory, extractedRuntimeMember)
  const extractedLicense = path.join(extractionDirectory, extractedLicenseMember)
  for (const filePath of [extractedRuntime, extractedLicense]) {
    const fileStat = await fs.lstat(filePath).catch(() => null)
    if (!fileStat?.isFile()) throw new Error(`Official Node.js archive was missing an expected file for ${platform}.`)
  }

  return { runtimePath: extractedRuntime, licensePath: extractedLicense }
}

async function writeRuntimeMetadata(appDirectory, platform, descriptor, archiveChecksum, checksumText) {
  const runtimeDirectory = path.join(appDirectory, 'runtime')
  await fs.mkdir(runtimeDirectory, { recursive: true })
  const runtimePath = path.join(runtimeDirectory, descriptor.runtimeExecutable)
  await fs.copyFile(descriptor.runtimePath, runtimePath)
  await fs.chmod(runtimePath, platform === 'linux-x64' ? 0o755 : 0o644)
  await fs.copyFile(descriptor.licensePath, path.join(runtimeDirectory, 'LICENSE'))
  await fs.writeFile(path.join(runtimeDirectory, 'SHASUMS256.txt'), checksumText, { mode: 0o644 })
  await fs.writeFile(path.join(runtimeDirectory, 'PROVENANCE.txt'), [
    'Node.js runtime provenance',
    `Version: v${NODE_VERSION}`,
    `Target: ${platform}`,
    `Archive: ${descriptor.nodeArchive}`,
    `Download: ${NODE_DIST_BASE}/${descriptor.nodeArchive}`,
    `Official checksum source: ${NODE_DIST_BASE}/SHASUMS256.txt`,
    `SHA-256: ${archiveChecksum}`,
    'Verification: archive SHA-256 matched the official SHASUMS256.txt fetched over HTTPS before extraction.',
    ''
  ].join('\n'), { mode: 0o644 })
}

async function createPlatformStage(platform, descriptor, baseAppDirectory, runtime, checksumText, workspace) {
  const stageRoot = path.join(workspace, `${platform}-package`)
  const appDirectory = path.join(stageRoot, 'realm-rtx-proxy')
  await fs.mkdir(stageRoot)
  await fs.cp(baseAppDirectory, appDirectory, { recursive: true })
  await fs.chmod(path.join(appDirectory, 'start-proxy.sh'), 0o755)
  await writeRuntimeMetadata(appDirectory, platform, {
    ...descriptor,
    ...runtime
  }, runtime.archiveChecksum, checksumText)
  return { stageRoot }
}

async function createPlatformArchive(platform, descriptor, stageRoot, distDirectory, version) {
  const filename = `realm-rtx-proxy-${version}-${platform}.${descriptor.archiveExtension}`
  const destination = path.join(distDirectory, filename)
  const temporaryOutput = path.join(distDirectory, `.${filename}.${randomUUID()}.tmp.${descriptor.archiveExtension}`)

  try {
    if (platform === 'linux-x64') {
      run('tar', [
        '--create', '--gzip', '--file', temporaryOutput,
        '--directory', stageRoot,
        '--numeric-owner', '--owner=0', '--group=0',
        'realm-rtx-proxy'
      ])
    } else {
      run('zip', ['-q', '-X', '-r', temporaryOutput, 'realm-rtx-proxy'], { cwd: stageRoot })
    }

    const size = (await fs.stat(temporaryOutput)).size
    if (size >= MAX_RELEASE_ASSET_BYTES) {
      throw new Error(`${filename} exceeds GitHub's 2 GB release asset limit.`)
    }
    return { filename, destination, temporaryOutput }
  } catch (error) {
    await fs.rm(temporaryOutput, { force: true })
    throw error
  }
}

async function readVersion() {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('package.json must contain a valid release version.')
  }
  return manifest.version
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Release packages must be built on a Linux x64 host.')
  }
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('The release builder must run under Node.js 24.')
  }

  const requestedPlatforms = parsePlatform(process.argv.slice(2))
  if (requestedPlatforms.includes('linux-x64')) {
    requireCommand('tar', ['--version'], 'Linux runtime extraction and archive creation')
  }
  if (requestedPlatforms.includes('win-x64')) {
    requireCommand('unzip', ['-v'], 'Windows runtime extraction')
    requireCommand('zip', ['-v'], 'Windows archive creation')
  }

  const version = await readVersion()
  const distDirectory = path.join(ROOT, 'dist')
  await fs.mkdir(distDirectory, { recursive: true })
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'realm-rtx-proxy-release-'))
  const temporaryOutputs = []
  let temporarySums

  try {
    const baseAppDirectory = path.join(workspace, 'dependency-stage', 'realm-rtx-proxy')
    await copyAllowlistedSources(baseAppDirectory)
    console.log('Installing production dependencies from the lockfile...')
    await installCleanDependencies(baseAppDirectory, workspace)
    await validateNativePrebuilds(baseAppDirectory, requestedPlatforms)

    const checksumText = await fetchChecksums()
    for (const platform of requestedPlatforms) {
      const descriptor = PLATFORMS[platform]
      console.log(`Preparing ${platform}...`)
      const verified = await getVerifiedArchive(platform, descriptor, checksumText, workspace)
      const runtime = await extractNodeRuntime(platform, descriptor, verified.archivePath, workspace)
      const { stageRoot } = await createPlatformStage(
        platform,
        descriptor,
        baseAppDirectory,
        { ...runtime, archiveChecksum: verified.checksum },
        checksumText,
        workspace
      )
      const asset = await createPlatformArchive(platform, descriptor, stageRoot, distDirectory, version)
      temporaryOutputs.push(asset)
      console.log(`Staged ${path.basename(asset.destination)}`)
    }

    const checksumLines = []
    for (const asset of temporaryOutputs) {
      checksumLines.push(`${await sha256File(asset.temporaryOutput)}  ${asset.filename}`)
    }
    temporarySums = path.join(distDirectory, `.SHA256SUMS.${randomUUID()}.tmp`)
    await fs.writeFile(temporarySums, `${checksumLines.sort().join('\n')}\n`, { flag: 'wx', mode: 0o644 })

    for (const asset of temporaryOutputs) await fs.rename(asset.temporaryOutput, asset.destination)
    await fs.rename(temporarySums, path.join(distDirectory, 'SHA256SUMS'))
    temporarySums = null

    for (const asset of temporaryOutputs) console.log(`Created dist/${asset.filename}`)
    console.log('Created dist/SHA256SUMS')
  } finally {
    for (const asset of temporaryOutputs) await fs.rm(asset.temporaryOutput, { force: true })
    if (temporarySums) await fs.rm(temporarySums, { force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(`Release build failed: ${error.message}`)
  process.exitCode = 1
})
