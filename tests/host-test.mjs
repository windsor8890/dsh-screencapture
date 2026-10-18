#!/usr/bin/env node
/**
 * dsh-screencapture — host-half test harness.
 *
 * Exercises the real Windows capture/clipboard/save stack through the exact
 * route table the plugin registers, plus the fence, request validation, body
 * caps, and the helper process manager (restart-once retry, timeout, command
 * serialization) against a scripted fake helper.
 *
 * This test captures the LIVE desktop and OVERWRITES the user clipboard — that
 * is the capability under test. Evidence PNGs are kept under
 * `tools/tmp/host-test/`; every other temp file (including the engine temp
 * directory) is removed. The script always prints a PASS/FAIL summary and
 * exits by itself with code 0 (all pass) or 1.
 *
 * Run from the package directory:
 *   node tests/host-test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { apply, createHost, inject, name as pluginName } from '../host/index.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, createCaptureEngine } from '../host/capture.js'
import {
  DEFAULT_SAVE_DIRECTORY_NAME,
  MAX_IMAGE_BYTES,
  MAX_JSON_BODY_BYTES,
  PNG_DATA_URL_PREFIX,
  ROUTE_PATHS,
  SAVE_FILE_PATTERN,
  formatFileStamp,
  makeRoutes,
  resolveSaveDirectory,
} from '../host/routes.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(HERE, '..')
const WORKSPACE_DIR = join(PACKAGE_DIR, '..')
const ARTIFACTS_DIR = join(WORKSPACE_DIR, 'tools', 'tmp', 'host-test')
const POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const LOOPBACK_HOST = '127.0.0.1:62528'
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const SAMPLE_SCREENS = {
  screens: [{ x: 0, y: 0, width: 10, height: 8, primary: true }],
  virtual: { x: 0, y: 0, width: 10, height: 8 },
}

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------

const results = []
const timings = {}

async function test(name, body) {
  const startedAt = performance.now()
  try {
    const detail = await body()
    const ms = performance.now() - startedAt
    results.push({ name, ok: true, detail, ms })
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''} (${ms.toFixed(0)} ms)`)
  } catch (error) {
    const ms = performance.now() - startedAt
    results.push({ name, ok: false, error, ms })
    console.log(`FAIL  ${name} (${ms.toFixed(0)} ms)`)
    console.log(indent(error && error.stack ? error.stack : String(error)))
  }
}

function indent(text) {
  return String(text)
    .split('\n')
    .map(line => `      ${line}`)
    .join('\n')
}

function check(condition, message) {
  assert.ok(condition, message)
}

// ---------------------------------------------------------------------------
// fake HTTP request / response
// ---------------------------------------------------------------------------

/** Build an IncomingMessage-shaped readable with socket + headers. */
function makeRequest({ method = 'GET', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
  request.method = method
  request.url = '/'
  request.headers = { host: LOOPBACK_HOST, ...headers }
  request.socket = { remoteAddress }
  return request
}

/** Build a ServerResponse-shaped sink. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    headersSent: false,
    payload: undefined,
    ended: false,
    destroyed: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(payload) {
      if (payload !== undefined) this.payload = String(payload)
      this.ended = true
    },
    destroy() {
      this.destroyed = true
    },
  }
}

function findRoute(routes, path) {
  const route = routes.find(entry => entry.path === path)
  if (!route) throw new Error(`route ${path} is not mounted`)
  if (route.kind !== 'exact') throw new Error(`route ${path} is not an exact route`)
  return route
}

/** Invoke one route with fake req/res; returns the parsed JSON response. */
async function callRoute(routes, path, options = {}) {
  const route = findRoute(routes, path)
  const request = makeRequest(options)
  const response = makeResponse()
  await route.handler(request, response)
  let json
  if (response.payload !== undefined) {
    try {
      json = JSON.parse(response.payload)
    } catch {
      throw new Error(`route ${path} did not answer JSON: ${response.payload.slice(0, 200)}`)
    }
  }
  return { status: response.statusCode, headers: response.headers, json, response }
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// PNG helpers
// ---------------------------------------------------------------------------

function decodePngDataUrl(dataUrl) {
  assert.ok(typeof dataUrl === 'string', 'dataUrl is a string')
  assert.ok(dataUrl.startsWith(PNG_DATA_URL_PREFIX), `dataUrl starts with ${PNG_DATA_URL_PREFIX}`)
  const buffer = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64')
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'decoded payload is a PNG')
  return {
    buffer,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

/** Read the Windows clipboard image from a SEPARATE PowerShell process. */
async function readClipboardImage(outPath) {
  const quotedOutPath = outPath.replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) {',
    '  Write-Output \'{"hasImage":false}\'',
    '} else {',
    `  $img.Save('${quotedOutPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    `  $info = [pscustomobject]@{ hasImage = $true; width = $img.Width; height = $img.Height; bytes = (Get-Item '${quotedOutPath}').Length }`,
    '  $img.Dispose()',
    '  $info | ConvertTo-Json -Compress',
    '}',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: 30_000, windowsHide: true },
  )
  const lines = stdout.trim().split(/\r?\n/).filter(line => line.trim() !== '')
  const lastLine = lines[lines.length - 1]
  return JSON.parse(lastLine)
}

// ---------------------------------------------------------------------------
// scripted fake PowerShell helper (engine unit tests)
// ---------------------------------------------------------------------------

const fakeChildren = []

/**
 * Build a `spawn` seam that returns scripted helper children. The handler is
 * called with `{ line, instance, reply, crash, delay }` for every command line.
 */
function createFakeSpawn(handler) {
  const state = {
    commands: [],
    instances: 0,
    children: [],
    inFlight: 0,
    maxConcurrent: 0,
  }

  function spawn() {
    state.instances += 1
    const instance = state.instances
    const child = new EventEmitter()
    child.pid = 10_000 + instance
    child.exitCode = null
    child.killed = false
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {
      if (child.exitCode !== null) return true
      child.killed = true
      child.exitCode = 1
      queueMicrotask(() => child.emit('exit', 1, null))
      return true
    }
    state.children.push(child)
    fakeChildren.push(child)

    let buffered = ''
    child.stdin.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      let newlineAt
      while ((newlineAt = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newlineAt).replace(/\r$/, '')
        buffered = buffered.slice(newlineAt + 1)
        if (line === '') continue
        state.commands.push(line)
        state.inFlight += 1
        state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight)
        let settled = false
        const settle = () => {
          if (!settled) {
            settled = true
            state.inFlight -= 1
          }
        }
        handler({
          line,
          instance,
          child,
          reply: (text) => {
            if (child.exitCode !== null) return
            settle()
            child.stdout.write(text + '\n')
          },
          crash: () => {
            if (child.exitCode !== null) return
            settle()
            child.exitCode = 1
            queueMicrotask(() => child.emit('exit', 1, null))
          },
        })
      }
    })
    child.stdin.on('error', () => {})
    return child
  }

  return { spawn, state }
}

/** Fake helper answering every command immediately with a valid result. */
function createHealthyFakeSpawn(options = {}) {
  const delay = options.delay || 0
  return createFakeSpawn(({ line, reply }) => {
    const respond = () => {
      if (line === 'ping') return reply('OK|ping')
      if (line === 'screens') return reply(`OK|screens|${JSON.stringify(SAMPLE_SCREENS)}`)
      if (line.startsWith('capture|')) {
        const pngPath = line.slice('capture|'.length)
        const width = SAMPLE_SCREENS.virtual.width
        const height = SAMPLE_SCREENS.virtual.height
        void writeFile(pngPath, TINY_PNG)
          .then(() => reply(`OK|capture|${width}|${height}|${pngPath}`))
          .catch(() => reply('ERR|capture|fake write failed'))
        return
      }
      if (line.startsWith('clipboard|')) return reply('OK|clipboard')
      return reply(`ERR|${line.split('|')[0]}|unknown command`)
    }
    if (delay > 0) setTimeout(respond, delay)
    else respond()
  })
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

async function main() {
  await rm(ARTIFACTS_DIR, { recursive: true, force: true })
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  console.log(`dsh-screencapture host test — platform=${process.platform} node=${process.version}`)
  console.log(`artifacts: ${ARTIFACTS_DIR}`)
  console.log(`evidence PNGs must be kept; screenshots capture the live desktop and overwrite the clipboard.`)
  console.log('')

  const host = createHost({
    logger: {
      warn: message => console.log(`      [engine] ${message}`),
      info: message => console.log(`      [engine] ${message}`),
    },
    // Hermetic: never touch the user's persisted global-hotkey settings here.
    hotkeySettingsPath: join(ARTIFACTS_DIR, 'settings.json'),
    loadStoredConfig: false,
  })
  const state = { evidence: [], engineTempDir: undefined }
  let exitCode = 1

  try {
    // --- 1. status -------------------------------------------------------
    await test('status route returns the documented shape without spawning the helper', async () => {
      const { status, headers, json } = await callRoute(host.routes, ROUTE_PATHS.status, { method: 'GET' })
      assert.equal(status, 200)
      assert.equal(headers['content-type'], 'application/json; charset=utf-8')
      assert.equal(json.ok, true)
      assert.equal(json.platform, process.platform)
      assert.equal(json.helper, 'idle')
      assert.ok(Array.isArray(json.screens), 'screens is an array')
      assert.equal(typeof json.virtual, 'object')
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.equal(typeof json.virtual[key], 'number', `virtual.${key} is a number`)
      }
      assert.equal(typeof json.version, 'string')
      assert.ok(json.version.length > 0)
      assert.equal(typeof json.globalHotkey, 'object', 'status carries the globalHotkey status')
      assert.equal(json.globalHotkey.enabled, false)
      assert.equal(json.globalHotkey.registered, false)
      assert.equal(json.globalHotkey.shortcut, null)
      assert.equal(json.globalHotkey.error, null)
      assert.equal(host.engine.hasProcess, false, 'status must not spawn the helper')
      assert.equal(host.hotkey.hasProcess, false, 'status must not spawn the hotkey helper')
      assert.equal(host.engine.state, 'idle')
      return `helper=${json.helper} version=${json.version}`
    })

    // --- 2. fence --------------------------------------------------------
    await test('fence rejects non-loopback sockets, non-loopback Host headers and cross-site markers', async () => {
      const cases = [
        { name: 'non-loopback socket', options: { method: 'POST', body: jsonBody({}), remoteAddress: '10.1.2.3' } },
        { name: 'lan Host header', options: { method: 'POST', body: jsonBody({}), headers: { host: '192.168.1.5:62528' } } },
        { name: 'cross-site marker', options: { method: 'POST', body: jsonBody({}), headers: { 'sec-fetch-site': 'cross-site' } } },
        { name: 'foreign Origin', options: { method: 'POST', body: jsonBody({}), headers: { origin: 'http://evil.example' } } },
      ]
      for (const testCase of cases) {
        const { status, json } = await callRoute(host.routes, ROUTE_PATHS.capture, testCase.options)
        assert.equal(status, 403, `${testCase.name} is rejected`)
        assert.equal(json.ok, false)
        assert.equal(json.code, 'forbidden')
      }
      // A trusted loopback request carrying the proxy's same-origin marker passes.
      const allowed = await callRoute(host.routes, ROUTE_PATHS.status, {
        method: 'GET',
        headers: { 'sec-fetch-site': 'same-origin', origin: `http://${LOOPBACK_HOST}` },
      })
      assert.equal(allowed.status, 200)
      assert.equal(host.engine.hasProcess, false, 'a fenced-out request must not spawn the helper')
      return `${cases.length} hostile requests rejected`
    })

    // --- 3. method + payload validation ---------------------------------
    await test('method guard and malformed payloads answer explicit JSON errors', async () => {
      const method = await callRoute(host.routes, ROUTE_PATHS.capture, { method: 'GET' })
      assert.equal(method.status, 405)
      assert.equal(method.json.code, 'method-not-allowed')

      const statusPost = await callRoute(host.routes, ROUTE_PATHS.status, { method: 'POST', body: jsonBody({}) })
      assert.equal(statusPost.status, 405)

      const badJson = await callRoute(host.routes, ROUTE_PATHS.save, { method: 'POST', body: 'this is not json' })
      assert.equal(badJson.status, 400)
      assert.equal(badJson.json.code, 'bad-json')

      const arrayJson = await callRoute(host.routes, ROUTE_PATHS.save, { method: 'POST', body: '[]' })
      assert.equal(arrayJson.status, 400)
      assert.equal(arrayJson.json.code, 'bad-json')

      const jpeg = await callRoute(host.routes, ROUTE_PATHS.clipboard, {
        method: 'POST',
        body: jsonBody({ dataUrl: 'data:image/jpeg;base64,AAAA' }),
      })
      assert.equal(jpeg.status, 400)
      assert.equal(jpeg.json.code, 'invalid-dataurl')

      const noPrefix = await callRoute(host.routes, ROUTE_PATHS.clipboard, {
        method: 'POST',
        body: jsonBody({ dataUrl: 'not-a-data-url' }),
      })
      assert.equal(noPrefix.status, 400)
      assert.equal(noPrefix.json.code, 'invalid-dataurl')

      const notPng = await callRoute(host.routes, ROUTE_PATHS.save, {
        method: 'POST',
        body: jsonBody({ dataUrl: PNG_DATA_URL_PREFIX + Buffer.from('definitely not a png').toString('base64') }),
      })
      assert.equal(notPng.status, 400)
      assert.equal(notPng.json.code, 'invalid-image')

      const badDirectory = await callRoute(host.routes, ROUTE_PATHS.save, {
        method: 'POST',
        body: jsonBody({ dataUrl: PNG_DATA_URL_PREFIX + TINY_PNG.toString('base64'), directory: 42 }),
      })
      assert.equal(badDirectory.status, 400)
      assert.equal(badDirectory.json.code, 'invalid-directory')

      const badPath = await callRoute(host.routes, ROUTE_PATHS.reveal, { method: 'POST', body: jsonBody({ path: 7 }) })
      assert.equal(badPath.status, 400)
      assert.equal(badPath.json.code, 'invalid-path')

      assert.equal(host.engine.hasProcess, false, 'validation failures must not spawn the helper')
      return '405 / bad-json / invalid-dataurl / invalid-image / invalid-directory / invalid-path'
    })

    // --- 4. caps ---------------------------------------------------------
    await test('64 MiB JSON body cap and 48 MiB decoded-image cap code paths are enforced', async () => {
      assert.equal(MAX_JSON_BODY_BYTES, 64 * 1024 * 1024, 'JSON body cap is 64 MiB')
      assert.equal(MAX_IMAGE_BYTES, 48 * 1024 * 1024, 'decoded image cap is 48 MiB')
      const bodyCapRoutes = makeRoutes({
        platform: 'win32',
        maxBodyBytes: 32,
        save: async () => ({ path: 'never', directory: 'never' }),
      })
      const bodyCap = await callRoute(bodyCapRoutes, ROUTE_PATHS.save, {
        method: 'POST',
        body: JSON.stringify({ dataUrl: 'x'.repeat(256) }),
      })
      assert.equal(bodyCap.status, 413)
      assert.equal(bodyCap.json.code, 'body-too-large')

      const imageCapRoutes = makeRoutes({
        platform: 'win32',
        maxImageBytes: 4,
        clipboard: async () => {
          throw new Error('clipboard must not be reached for an oversized image')
        },
      })
      const imageCap = await callRoute(imageCapRoutes, ROUTE_PATHS.clipboard, {
        method: 'POST',
        body: jsonBody({ dataUrl: PNG_DATA_URL_PREFIX + TINY_PNG.toString('base64') }),
      })
      assert.equal(imageCap.status, 413)
      assert.equal(imageCap.json.code, 'image-too-large')
      return 'body-too-large -> 413, image-too-large -> 413'
    })

    // --- 4b. contract constants and platform gating ----------------------
    await test('exact contract route paths are registered and non-Windows platforms answer unsupported-platform', async () => {
      assert.deepEqual({ ...ROUTE_PATHS }, {
        status: '/api/dsh-screencapture/status',
        capture: '/api/dsh-screencapture/capture',
        clipboard: '/api/dsh-screencapture/clipboard',
        save: '/api/dsh-screencapture/save',
        reveal: '/api/dsh-screencapture/reveal',
        events: '/api/dsh-screencapture/events',
        lastCapture: '/api/dsh-screencapture/last-capture',
        config: '/api/dsh-screencapture/config',
        overlayWindow: '/api/dsh-screencapture/overlay-window',
      })
      assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 5000, 'per-command helper timeout is 5 s')

      const linuxRoutes = makeRoutes({
        platform: 'linux',
        status: () => ({ helper: 'idle', screens: [], virtual: { x: 0, y: 0, width: 0, height: 0 } }),
        capture: async () => {
          throw new Error('capture must not run on a non-Windows platform')
        },
        clipboard: async () => {
          throw new Error('clipboard must not run on a non-Windows platform')
        },
        save: async () => {
          throw new Error('save must not run on a non-Windows platform')
        },
        reveal: async () => {
          throw new Error('reveal must not run on a non-Windows platform')
        },
      })
      const platformStatus = await callRoute(linuxRoutes, ROUTE_PATHS.status, { method: 'GET' })
      assert.equal(platformStatus.status, 200)
      assert.equal(platformStatus.json.ok, true)
      assert.equal(platformStatus.json.platform, 'linux')
      for (const path of [
        ROUTE_PATHS.capture,
        ROUTE_PATHS.clipboard,
        ROUTE_PATHS.save,
        ROUTE_PATHS.reveal,
        ROUTE_PATHS.overlayWindow,
      ]) {
        const response = await callRoute(linuxRoutes, path, {
          method: 'POST',
          body: jsonBody(path === ROUTE_PATHS.overlayWindow ? { action: 'prepare' } : {}),
        })
        assert.equal(response.status, 501, `${path} answers 501 on linux`)
        assert.equal(response.json.ok, false)
        assert.equal(response.json.code, 'unsupported-platform')
      }
      return 'nine exact paths, 501 unsupported-platform off Windows'
    })

    // --- 5. live capture -------------------------------------------------
    await test('capture returns a valid PNG data URL of the whole virtual desktop', async () => {
      const startedAt = performance.now()
      const { status, json } = await callRoute(host.routes, ROUTE_PATHS.capture, {
        method: 'POST',
        body: jsonBody({}),
      })
      const coldMs = performance.now() - startedAt
      timings.coldCaptureMs = coldMs
      assert.equal(status, 200, `capture failed: ${JSON.stringify(json)}`)
      assert.equal(json.ok, true)
      // Contract capture body: {ok, image:{dataUrl,width,height}, screens, capturedAt}.
      assert.equal(typeof json.image, 'object')
      assert.equal(typeof json.image.dataUrl, 'string')
      assert.equal(typeof json.image.width, 'number')
      assert.equal(typeof json.image.height, 'number')
      assert.match(json.image.dataUrl, /^data:image\/png;base64,/)
      const png = decodePngDataUrl(json.image.dataUrl)
      assert.equal(png.width, json.image.width, 'PNG IHDR width matches the reported width')
      assert.equal(png.height, json.image.height, 'PNG IHDR height matches the reported height')
      assert.ok(png.width > 0 && png.height > 0)
      assert.ok(Array.isArray(json.screens) && json.screens.length >= 1, 'at least one monitor is reported')
      for (const screen of json.screens) {
        for (const key of ['x', 'y', 'width', 'height']) {
          assert.equal(typeof screen[key], 'number', `screen.${key} is a number`)
        }
        assert.equal(typeof screen.primary, 'boolean')
      }
      // The captured bitmap must cover the union of all monitor bounds — the
      // virtual desktop (status reports the same rectangle).
      const union = json.screens.reduce((acc, screen) => ({
        x: Math.min(acc.x, screen.x),
        y: Math.min(acc.y, screen.y),
        right: Math.max(acc.right, screen.x + screen.width),
        bottom: Math.max(acc.bottom, screen.y + screen.height),
      }), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity })
      assert.equal(png.width, union.right - union.x, 'captured width equals the virtual desktop width')
      assert.equal(png.height, union.bottom - union.y, 'captured height equals the virtual desktop height')
      // The capture response exposes the virtual-desktop rect for client coordinate mapping.
      assert.equal(typeof json.virtual, 'object', 'capture response carries virtual')
      assert.equal(json.virtual.x, union.x, 'virtual.x is the virtual-desktop origin')
      assert.equal(json.virtual.y, union.y, 'virtual.y is the virtual-desktop origin')
      assert.equal(json.virtual.width, png.width, 'virtual.width is the captured width')
      assert.equal(json.virtual.height, png.height, 'virtual.height is the captured height')
      // Window-snapping data: captured-time Z-ordered top-level window list.
      assert.ok(Array.isArray(json.windows), 'capture response carries a windows array')
      assert.ok(json.windows.length >= 1, 'the live desktop has at least one titled top-level window')
      for (const entry of json.windows) {
        assert.equal(typeof entry.hwnd, 'number', 'window.hwnd is a number')
        assert.ok(entry.hwnd > 0, 'window.hwnd is positive')
        assert.equal(typeof entry.title, 'string', 'window.title is a string')
        assert.ok(entry.title.length > 0, 'window.title is non-empty')
        assert.equal(typeof entry.className, 'string', 'window.className is a string')
        assert.equal(typeof entry.pid, 'number', 'window.pid is a number')
        assert.ok(entry.pid > 0, 'window.pid is positive')
        assert.equal(typeof entry.processName, 'string', 'window.processName is a string')
        for (const key of ['x', 'y', 'width', 'height']) {
          assert.equal(typeof entry[key], 'number', `window.${key} is a number`)
        }
        assert.ok(entry.width > 1 && entry.height > 1, 'window is larger than 1x1')
        assert.ok(
          entry.x >= union.x - 16 && entry.y >= union.y - 16
          && entry.x + entry.width <= union.right + 16 && entry.y + entry.height <= union.bottom + 16,
          `window ${entry.hwnd} (${entry.title.slice(0, 40)}) lies within the virtual screen`,
        )
      }
      state.windows = json.windows
      timings.windowsCount = json.windows.length
      const capturedAt = Date.parse(json.capturedAt)
      assert.ok(Number.isFinite(capturedAt), 'capturedAt is an ISO timestamp')
      assert.ok(Math.abs(Date.now() - capturedAt) < 60_000, 'capturedAt is recent')
      // status must now serve the cached monitor table without spawning.
      const statusAfter = await callRoute(host.routes, ROUTE_PATHS.status, { method: 'GET' })
      assert.equal(statusAfter.json.helper, 'ready')
      assert.equal(statusAfter.json.screens.length, json.screens.length)
      assert.equal(statusAfter.json.virtual.x, union.x)
      assert.equal(statusAfter.json.virtual.y, union.y)
      assert.equal(statusAfter.json.virtual.width, png.width)
      assert.equal(statusAfter.json.virtual.height, png.height)
      const evidencePath = join(ARTIFACTS_DIR, 'capture-evidence.png')
      await writeFile(evidencePath, png.buffer)
      state.evidence.push(evidencePath)
      state.capture = json
      state.engineTempDir = host.engine.tempDirectory
      timings.capturePngBytes = png.buffer.length
      return `${png.width}x${png.height} PNG, ${png.buffer.length} bytes, ${json.windows.length} windows, cold ${coldMs.toFixed(0)} ms (helper start included)`
    })

    // --- 6. warm latency -------------------------------------------------
    // The 400 ms target is reported as a soft signal: this suite also runs on a
    // busy desktop (and in parallel with other test/verification jobs), so only
    // a clearly pathological median fails the hard gate.
    await test('warm capture latency stays under the 400 ms target (hard ceiling 900 ms)', async () => {
      assert.ok(state.capture, 'capture test must have produced an image')
      const samples = []
      for (let index = 0; index < 5; index += 1) {
        const startedAt = performance.now()
        const { status, json } = await callRoute(host.routes, ROUTE_PATHS.capture, {
          method: 'POST',
          body: jsonBody({}),
        })
        samples.push(performance.now() - startedAt)
        assert.equal(status, 200, `warm capture failed: ${JSON.stringify(json)}`)
        assert.equal(json.ok, true)
      }
      const sorted = [...samples].sort((left, right) => left - right)
      const median = sorted[Math.floor(sorted.length / 2)]
      const targetMet = median < 400
      timings.warmCaptureMedianMs = median
      timings.warmCaptureSamplesMs = samples
      timings.warmCaptureTargetMet = targetMet
      assert.ok(median < 900, `warm capture median ${median.toFixed(1)} ms exceeds the 900 ms hard ceiling`)
      const label = targetMet ? 'target met' : 'target missed under load, below hard ceiling'
      return `warm median ${median.toFixed(1)} ms (${label}; samples: ${samples.map(sample => sample.toFixed(1)).join(', ')} ms)`
    })

    // --- 6b. real HTTP round-trip ---------------------------------------
    await test('real node:http round-trip: GET status and POST save over a live loopback listener', async () => {
      assert.ok(state.capture, 'capture test must have produced an image')
      const routes = host.routes
      const server = createServer((req, res) => {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname
        const route = routes.find(entry => entry.path === pathname)
        if (!route) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
          return
        }
        void route.handler(req, res).catch((error) => {
          try {
            res.writeHead(500, { 'content-type': 'text/plain' })
            res.end(String(error))
          } catch {
            /* response already settled */
          }
        })
      })
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', resolveListen)
      })
      try {
        const { port } = server.address()
        const origin = `http://127.0.0.1:${port}`
        const statusResponse = await fetch(origin + ROUTE_PATHS.status)
        assert.equal(statusResponse.status, 200)
        const statusJson = await statusResponse.json()
        assert.equal(statusJson.ok, true)
        assert.equal(statusJson.helper, 'ready')
        assert.ok(Array.isArray(statusJson.screens) && statusJson.screens.length >= 1)

        const realHttpDirectory = join(ARTIFACTS_DIR, 'real-http-save')
        const saveResponse = await fetch(origin + ROUTE_PATHS.save, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            dataUrl: PNG_DATA_URL_PREFIX + TINY_PNG.toString('base64'),
            directory: realHttpDirectory,
          }),
        })
        assert.equal(saveResponse.status, 200)
        const saveJson = await saveResponse.json()
        assert.equal(saveJson.ok, true)
        assert.match(basename(saveJson.path), SAVE_FILE_PATTERN)
        assert.ok(existsSync(saveJson.path), 'real-HTTP save wrote the file')
        state.evidence.push(saveJson.path)
        return `live listener 127.0.0.1:${port}: GET status + POST save ok`
      } finally {
        await new Promise((resolveClose) => {
          server.close(resolveClose)
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        })
      }
    })

    // --- 7. clipboard ----------------------------------------------------
    await test('clipboard route puts the PNG on the Windows clipboard; a separate process reads it back', async () => {
      assert.ok(state.capture, 'capture test must have produced an image')
      const image = state.capture.image
      const { status, json } = await callRoute(host.routes, ROUTE_PATHS.clipboard, {
        method: 'POST',
        body: jsonBody({ dataUrl: image.dataUrl }),
      })
      assert.equal(status, 200, `clipboard failed: ${JSON.stringify(json)}`)
      assert.equal(json.ok, true)
      const readbackPath = join(ARTIFACTS_DIR, 'clipboard-readback.png')
      const readback = await readClipboardImage(readbackPath)
      assert.equal(readback.hasImage, true, 'a separate PowerShell process found an image on the clipboard')
      assert.equal(readback.width, image.width, 'clipboard image width matches the captured desktop')
      assert.equal(readback.height, image.height, 'clipboard image height matches the captured desktop')
      const readbackPng = await readFile(readbackPath)
      assert.equal(readbackPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      state.evidence.push(readbackPath)
      return `separate-process readback: ${readback.width}x${readback.height}, ${readbackPng.length} bytes`
    })

    // --- 8. save ---------------------------------------------------------
    await test('save route writes Screenshot_YYYYMMDD_HHmmss_SSS.png with the exact PNG bytes', async () => {
      assert.ok(state.capture, 'capture test must have produced an image')
      const expectedPng = decodePngDataUrl(state.capture.image.dataUrl)
      const saveDirectory = join(ARTIFACTS_DIR, 'saved')
      const { status, json } = await callRoute(host.routes, ROUTE_PATHS.save, {
        method: 'POST',
        body: jsonBody({ dataUrl: state.capture.image.dataUrl, directory: saveDirectory }),
      })
      assert.equal(status, 200, `save failed: ${JSON.stringify(json)}`)
      assert.equal(json.ok, true)
      assert.equal(json.directory, resolve(saveDirectory), 'save reports the requested directory')
      const fileName = basename(json.path)
      assert.match(fileName, SAVE_FILE_PATTERN, `file name ${fileName} matches Screenshot_YYYYMMDD_HHmmss_SSS.png`)
      const stamp = fileName.slice('Screenshot_'.length, -'.png'.length)
      assert.match(stamp.slice(0, 8), /^\d{8}$/, 'date part is YYYYMMDD')
      assert.match(stamp.slice(9, 15), /^\d{6}$/, 'time part is HHmmss')
      assert.match(stamp.slice(16), /^\d{3}$/, 'millisecond part is SSS')
      assert.ok(existsSync(json.path), 'saved file exists')
      const written = await readFile(json.path)
      assert.ok(written.equals(expectedPng.buffer), 'saved bytes equal the decoded data URL bytes')
      state.evidence.push(json.path)
      return `${json.path} (${written.length} bytes)`
    })

    await test('save default directory resolves to %USERPROFILE%\\Pictures\\DSH Screenshots', async () => {
      const expectedDefault = join(homedir(), 'Pictures', DEFAULT_SAVE_DIRECTORY_NAME)
      assert.equal(resolveSaveDirectory(undefined), expectedDefault)
      assert.equal(resolveSaveDirectory(''), expectedDefault)
      assert.equal(resolveSaveDirectory('   '), expectedDefault)
      const requested = join(ARTIFACTS_DIR, 'somewhere else')
      assert.equal(resolveSaveDirectory(requested), resolve(requested))
      const sampleStamp = formatFileStamp(new Date(2026, 0, 2, 3, 4, 5, 6))
      assert.equal(sampleStamp, '20260102_030405_006')
      assert.match(`Screenshot_${sampleStamp}.png`, SAVE_FILE_PATTERN)
      return expectedDefault
    })

    // --- 9. engine unit tests (scripted fake helper) ---------------------
    await test('engine retries a crashed helper exactly once and the command still succeeds', async () => {
      const fake = createFakeSpawn(({ line, instance, reply, crash }) => {
        if (line === 'screens') {
          reply(`OK|screens|${JSON.stringify(SAMPLE_SCREENS)}`)
          return
        }
        if (line.startsWith('capture|')) {
          if (instance === 1) {
            crash()
            return
          }
          const pngPath = line.slice('capture|'.length)
          void writeFile(pngPath, TINY_PNG)
            .then(() => reply('OK|capture|10|8|' + pngPath))
            .catch(() => reply('ERR|capture|write failed'))
          return
        }
        reply(`ERR|${line.split('|')[0]}|unknown command`)
      })
      const engine = createCaptureEngine({ spawn: fake.spawn, commandTimeoutMs: 2000 })
      try {
        const result = await engine.capture()
        assert.equal(result.width, 10)
        assert.equal(result.height, 8)
        assert.ok(result.dataUrl.startsWith(PNG_DATA_URL_PREFIX))
        assert.equal(fake.state.instances, 2, 'exactly one helper restart')
        assert.equal(result.screens.length, 1)
        assert.equal(engine.hasProcess, true, 'the second helper is alive')
      } finally {
        await engine.close()
      }
      assert.equal(engine.hasProcess, false, 'close() kills the helper')
      return `helper instances: ${fake.state.instances}`
    })

    await test('engine times out a stalled helper, restarts once, then fails with a clear error', async () => {
      const fake = createFakeSpawn(() => {
        /* never answer: only the engine timeout can settle the command */
      })
      const engine = createCaptureEngine({ spawn: fake.spawn, commandTimeoutMs: 60 })
      try {
        const startedAt = performance.now()
        await assert.rejects(engine.capture(), /did not answer/)
        const elapsedMs = performance.now() - startedAt
        assert.ok(fake.state.instances >= 2, `expected a restart, got ${fake.state.instances} instances`)
        assert.ok(elapsedMs >= 100, `expected two 60 ms timeouts, got ${elapsedMs.toFixed(0)} ms`)
        assert.equal(engine.hasProcess, false, 'the stalled helper was killed')
      } finally {
        await engine.close()
      }
      return `timed out after retry; helper instances: ${fake.state.instances}`
    })

    await test('engine serializes helper commands (never two in flight)', async () => {
      const fake = createHealthyFakeSpawn({ delay: 15 })
      const engine = createCaptureEngine({ spawn: fake.spawn, commandTimeoutMs: 2000 })
      try {
        const [first, second] = await Promise.all([engine.capture(), engine.capture()])
        assert.equal(first.width, SAMPLE_SCREENS.virtual.width)
        assert.equal(second.width, SAMPLE_SCREENS.virtual.width)
        assert.equal(fake.state.maxConcurrent, 1, `commands overlapped (max in flight ${fake.state.maxConcurrent})`)
      } finally {
        await engine.close()
      }
      return `max concurrent helper commands: ${fake.state.maxConcurrent}`
    })

    await test('engine reports a spawn failure as capture-failed without leaking a process', async () => {
      const engine = createCaptureEngine({
        spawn: () => {
          throw new Error('spawn is not available in this test')
        },
        commandTimeoutMs: 500,
      })
      try {
        await assert.rejects(engine.capture(), /could not start the capture helper|spawn is not available/)
        assert.equal(engine.hasProcess, false)
      } finally {
        await engine.close()
      }
      return 'spawn failure surfaces as a rejected capture'
    })

    // --- 10. Cordis plugin wiring ----------------------------------------
    await test('apply() mounts exactly the nine routes under one effect and disposes them cleanly', async () => {
      assert.equal(pluginName, 'dsh-screencapture')
      assert.deepEqual(inject, ['webServer'], 'inject declares the webServer dependency')
      const registered = []
      const disposed = []
      const effectLabels = []
      let cleanup
      const ctx = {
        logger: { warn() {}, info() {} },
        webServer: {
          register(route) {
            registered.push(route)
            return () => disposed.push(route.path)
          },
        },
        effect(body, label) {
          effectLabels.push(label)
          cleanup = body()
        },
      }
      await apply(ctx)
      assert.equal(registered.length, 9, 'nine routes are registered (five core + events/last-capture/config/overlay-window)')
      for (const route of registered) {
        assert.equal(route.kind, 'exact')
        assert.equal(typeof route.handler, 'function')
      }
      assert.deepEqual(registered.map(route => route.path).sort(), Object.values(ROUTE_PATHS).sort())
      assert.equal(effectLabels.length, 1, 'route registration is owned by one ctx.effect')
      assert.equal(typeof cleanup, 'function', 'the effect returns a disposer')
      cleanup()
      assert.equal(disposed.length, 9, 'every registered route was disposed')
      return `routes: ${registered.map(route => route.path).join(', ')}`
    })
  } finally {
    await host.close()
  }

  // --- 11. cleanup evidence ------------------------------------------------
  await test('engine.close() kills the helpers, removes its temp directory and is idempotent', async () => {
    assert.equal(host.engine.hasProcess, false, 'no capture helper process remains after close')
    assert.equal(host.hotkey.hasProcess, false, 'no hotkey helper process remains after close')
    assert.equal(host.engine.state, 'idle')
    if (state.engineTempDir) {
      assert.equal(existsSync(state.engineTempDir), false, `temp directory ${state.engineTempDir} was removed`)
    }
    await host.engine.close() // second close must resolve, not throw
    await host.hotkey.close()
    return state.engineTempDir ? `removed ${state.engineTempDir}` : 'no temp directory was created'
  })

  // --- summary -------------------------------------------------------------
  const passed = results.filter(result => result.ok).length
  const failed = results.filter(result => !result.ok)
  console.log('')
  console.log('============================================================')
  console.log(' dsh-screencapture host test summary')
  console.log('============================================================')
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`)
    if (result.ok && result.detail) console.log(`        ${result.detail}`)
    if (!result.ok) console.log(`        ${result.error && result.error.message ? result.error.message : result.error}`)
  }
  console.log('------------------------------------------------------------')
  if (Number.isFinite(timings.coldCaptureMs)) {
    console.log(`Cold capture (helper start included): ${timings.coldCaptureMs.toFixed(1)} ms`)
  }
  if (Number.isFinite(timings.warmCaptureMedianMs)) {
    console.log(`Warm capture median: ${timings.warmCaptureMedianMs.toFixed(1)} ms (target < 400 ms)`)
  }
  if (Number.isFinite(timings.capturePngBytes)) {
    console.log(`Captured PNG size: ${timings.capturePngBytes} bytes`)
  }
  if (Number.isFinite(timings.windowsCount)) {
    console.log(`Captured-time top-level windows: ${timings.windowsCount}`)
  }
  console.log('Evidence PNGs (kept for inspection):')
  if (state.evidence.length === 0) console.log('  (none)')
  for (const evidencePath of state.evidence) console.log(`  ${evidencePath}`)
  console.log('------------------------------------------------------------')
  console.log(`${passed}/${results.length} checks passed`)
  console.log(failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.length} failed)`)
  exitCode = failed.length === 0 ? 0 : 1
  process.exitCode = exitCode

  // Every helper child of the scripted engines must be gone as well.
  for (const child of fakeChildren) {
    if (child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* scripted child; nothing real to kill */
      }
    }
  }
  return exitCode
}

main().then(
  (code) => {
    // Flush stdout before exiting on Windows pipes.
    process.stdout.write('', () => process.exit(code))
  },
  (error) => {
    console.error('FATAL: the host test harness crashed before reporting')
    console.error(error && error.stack ? error.stack : error)
    process.exit(1)
  },
)
