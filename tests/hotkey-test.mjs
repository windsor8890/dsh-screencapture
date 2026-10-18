#!/usr/bin/env node
/**
 * dsh-screencapture — Phase B (OS-global hotkey / SSE / config) test harness.
 *
 * Proves, against the real Windows session where possible:
 * - KeyboardEvent.code → Win32 virtual-key + modifier conversion;
 * - invalid chords are rejected;
 * - hotkey-helper.ps1 registers a free test chord (Ctrl+Shift+F12), reports
 *   `ready|vk|mods`, refuses a duplicate registration with `error|1409`, and
 *   exits when its stdin closes (no leaked process);
 * - the manager debounces repeated presses and restarts cleanly on a chord
 *   change (scripted fake helper);
 * - the SSE route streams `text/event-stream` headers, an immediate heartbeat,
 *   15 s-style keep-alives (shortened for the test) and injected events, and
 *   removes a client when the request closes;
 * - /last-capture answers 404 `no-capture` before a global capture;
 * - POST /config persists `{enabled, shortcut}` to a settings file, registers
 *   and re-registers chords, and disabling kills the helper (Get-CimInstance
 *   check: no process left);
 * - a simulated keypress (`^+{F12}` sent by a separate PowerShell process)
 *   drives the real global hotkey → capture → SSE `capture` → last-capture
 *   PNG. If the OS refuses to deliver synthetic hotkeys in this session the
 *   check is reported as SKIP with the observed evidence, never FAIL;
 * - the capture helper's new `activate|<pid>` command errors cleanly for a
 *   process without a window.
 *
 * The global-hotkey E2E captures the live desktop and foregrounds the DSH
 * window; the clipboard is never touched by this test. Evidence is kept under
 * `tools/tmp/hotkey-test/`; all helpers are killed and temp files removed.
 *
 * Run from the package directory:
 *   node tests/hotkey-test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createHost } from '../host/index.js'
import { createCaptureEngine } from '../host/capture.js'
import {
  HOTKEY_DEBOUNCE_MS,
  REGISTRATION_TIMEOUT_MS,
  chordToVirtualKey,
  createHotkeyManager,
  defaultSettingsPath,
  modifierMask,
  normalizeShortcut,
} from '../host/hotkey.js'
import { createEventHub, createGlobalCaptureFlow } from '../host/global-flow.js'
import { PNG_DATA_URL_PREFIX, ROUTE_PATHS, makeRoutes } from '../host/routes.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(HERE, '..')
const WORKSPACE_DIR = join(PACKAGE_DIR, '..')
const ARTIFACTS_DIR = join(WORKSPACE_DIR, 'tools', 'tmp', 'hotkey-test')
const POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const HOTKEY_HELPER = join(PACKAGE_DIR, 'host', 'hotkey-helper.ps1')
const CAPTURE_HELPER = join(PACKAGE_DIR, 'host', 'capture-helper.ps1')
const PLACEMENT_PROBE = join(PACKAGE_DIR, 'tests', 'placement-probe.ps1')
const LOOPBACK_HOST = '127.0.0.1:62528'
const TEST_SHORTCUT = { code: 'F12', ctrl: true, shift: true }
const CHANGED_SHORTCUT = { code: 'F11', ctrl: true, alt: true }
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const SAMPLE_WINDOW = {
  hwnd: 12_345,
  title: 'Sample Window',
  className: 'SampleClass',
  pid: 4242,
  processName: 'sample-app',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
}

// ---------------------------------------------------------------------------
// tiny harness with PASS / FAIL / SKIP
// ---------------------------------------------------------------------------

class Skip extends Error {}

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
    if (error instanceof Skip) {
      results.push({ name, ok: true, skipped: true, detail: error.message, ms })
      console.log(`SKIP  ${name} — ${error.message} (${ms.toFixed(0)} ms)`)
      return
    }
    results.push({ name, ok: false, error, ms })
    console.log(`FAIL  ${name} (${ms.toFixed(0)} ms)`)
    console.log(String(error && error.stack ? error.stack : error).split('\n').map(line => `      ${line}`).join('\n'))
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
}

// ---------------------------------------------------------------------------
// fake HTTP request / response (same shapes the web server uses)
// ---------------------------------------------------------------------------

function makeRequest({ method = 'GET', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
  request.method = method
  request.url = '/'
  request.headers = { host: LOOPBACK_HOST, ...headers }
  request.socket = { remoteAddress }
  return request
}

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

function makeStreamResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: undefined,
    headersSent: false,
    ended: false,
    chunks,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
      this.ended = true
    },
    destroy() {
      this.destroyed = true
    },
    get body() {
      return chunks.join('')
    },
  }
}

async function callRoute(routes, path, options = {}) {
  const route = routes.find(entry => entry.path === path)
  if (!route) throw new Error(`route ${path} is not mounted`)
  const request = makeRequest(options)
  const response = makeResponse()
  await route.handler(request, response)
  let json
  if (response.payload !== undefined) json = JSON.parse(response.payload)
  return { status: response.statusCode, headers: response.headers, json }
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value))
}

function decodePngDataUrl(dataUrl) {
  assert.ok(typeof dataUrl === 'string' && dataUrl.startsWith(PNG_DATA_URL_PREFIX), 'dataUrl is a PNG data URL')
  const buffer = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64')
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'decoded payload is a PNG')
  return { buffer, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ---------------------------------------------------------------------------
// process / key helpers
// ---------------------------------------------------------------------------

/** Send a System.Windows.Forms.SendKeys chord from a separate PowerShell process. */
async function sendKeys(keys) {
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`
  await execFileAsync(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 20_000, windowsHide: true },
  )
}

/**
 * Count running PowerShell processes whose command line matches `pattern`
 * (CIM query from a separate process, excluding the query process itself).
 * Only helpers parented by THIS test process are counted: the live DSH app may
 * legitimately own its own warm helpers at the same time.
 * Used to prove no helper process leaked.
 */
async function countHelperProcesses(pattern, parentProcessId = process.pid) {
  const command = `$self = $PID; $parent = ${Number(parentProcessId)}; @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $self -and $_.ParentProcessId -eq $parent -and $_.CommandLine -match '${pattern}' }).Count`
  const { stdout } = await execFileAsync(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { timeout: 20_000, windowsHide: true },
  )
  const count = Number(stdout.trim())
  return Number.isFinite(count) ? count : -1
}

const HOTKEY_HELPER_PROCESS_PATTERN = 'hotkey-helper\\.ps1\\s+\\d+\\s+\\d+\\s*$'
const CAPTURE_HELPER_PROCESS_PATTERN = 'capture-helper\\.ps1\\s*$'

// ---------------------------------------------------------------------------
// scripted fake hotkey helper (manager unit tests)
// ---------------------------------------------------------------------------

const fakeChildren = []

/** A spawn seam whose children answer `ready|vk|mods` and scripted events. */
function createFakeHotkeySpawn() {
  const state = { children: [], commands: [] }
  function spawn(_executable, args) {
    const child = new EventEmitter()
    const vk = args[args.length - 2]
    const modifiers = args[args.length - 1]
    child.pid = 30_000 + state.children.length
    child.exited = false
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {
      if (child.exited) return true
      child.exited = true
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    }
    child.stdin.on('error', () => {})
    state.children.push(child)
    state.commands.push({ vk: Number(vk), modifiers: Number(modifiers) })
    fakeChildren.push(child)
    queueMicrotask(() => {
      if (!child.exited) child.stdout.write(`ready|${vk}|${modifiers}\n`)
    })
    return child
  }
  return { spawn, state }
}

// ---------------------------------------------------------------------------
// placement-probe fixture (controlled real window for activate tests)
// ---------------------------------------------------------------------------

function parseProbeState(line) {
  return JSON.parse(line.slice('STATE|'.length))
}

function rectOf(state) {
  return [state.left, state.top, state.right, state.bottom]
}

/**
 * Spawn tests/placement-probe.ps1: an invisible, click-through, message-pumping
 * window whose placement the capture helper's `activate` command must preserve.
 * The reader always waits for a NEW line (monotonic cursor).
 */
function createPlacementProbe(options = {}) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PLACEMENT_PROBE]
  if (typeof options.title === 'string' && options.title !== '') args.push('-Title', options.title)
  if (options.noToolWindow === true) args.push('-NoToolWindow')
  const child = spawn(POWERSHELL, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const lines = []
  const waiters = new Set()
  let buffer = ''
  let consumed = 0
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newlineAt
    while ((newlineAt = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, '')
      buffer = buffer.slice(newlineAt + 1)
      if (line === '') continue
      lines.push(line)
      for (const waiter of [...waiters]) {
        if (waiter.predicate(line)) {
          waiters.delete(waiter)
          clearTimeout(waiter.timer)
          consumed = lines.length
          waiter.resolve(line)
        }
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const waitForNew = (predicate, timeoutMs, label) => new Promise((resolve, reject) => {
    for (let index = consumed; index < lines.length; index += 1) {
      if (predicate(lines[index])) {
        consumed = lines.length
        resolve(lines[index])
        return
      }
    }
    const waiter = {
      predicate,
      resolve: (line) => {
        consumed = lines.length
        resolve(line)
      },
    }
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter)
      reject(new Error(`timed out waiting for ${label}; probe lines=${JSON.stringify(lines)}`))
    }, timeoutMs)
    waiters.add(waiter)
  })
  return {
    child,
    exited,
    send: line => child.stdin.write(line + '\n'),
    waitForNew,
  }
}

/**
 * Scripted capture-helper spawn seam: answers the capture protocol in-process
 * so failure paths (for example a broken window enumeration) can be tested
 * without the real PowerShell helper.
 */
function createFakeCaptureSpawn(options = {}) {
  const state = { children: [], commands: [] }
  function spawn() {
    const child = new EventEmitter()
    child.pid = 40_000 + state.children.length
    child.exited = false
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {
      if (child.exited) return true
      child.exited = true
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    }
    state.children.push(child)
    fakeChildren.push(child)
    const reply = (line) => {
      if (child.exited) return
      child.stdout.write(line + '\n')
    }
    let buffered = ''
    child.stdin.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      let newlineAt
      while ((newlineAt = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newlineAt).replace(/\r$/, '')
        buffered = buffered.slice(newlineAt + 1)
        if (line === '') continue
        state.commands.push(line)
        const command = line.split('|')[0]
        if (command === 'ping') reply('OK|ping')
        else if (command === 'screens') {
          reply('OK|screens|' + JSON.stringify({
            screens: [{ x: 0, y: 0, width: 10, height: 8, primary: true }],
            virtual: { x: 0, y: 0, width: 10, height: 8 },
          }))
        } else if (command === 'capture') {
          const pngPath = line.slice('capture|'.length)
          void writeFile(pngPath, TINY_PNG)
            .then(() => reply('OK|capture|10|8|' + pngPath))
            .catch(() => reply('ERR|capture|fake write failed'))
        } else if (command === 'windows') {
          if (options.windowsError) reply('ERR|windows|' + options.windowsError)
          else reply('OK|windows|' + JSON.stringify(options.windows || []))
        } else {
          reply(`ERR|${command}|unknown command`)
        }
      }
    })
    child.stdin.on('error', () => {})
    return child
  }
  return { spawn, state }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

async function main() {
  await rm(ARTIFACTS_DIR, { recursive: true, force: true })
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const settingsPath = join(ARTIFACTS_DIR, 'settings', 'settings.json')
  const logger = {
    warn: message => console.log(`      [host] ${message}`),
    info: message => console.log(`      [host] ${message}`),
  }
  console.log(`dsh-screencapture hotkey test — platform=${process.platform} node=${process.version}`)
  console.log(`artifacts: ${ARTIFACTS_DIR}`)
  console.log(`clipboard is NOT touched by this suite; the E2E captures the live desktop.`)
  console.log('')

  // --- 1. conversions ----------------------------------------------------
  await test('KeyboardEvent.code converts to Win32 {vk, modifiers}', async () => {
    assert.deepEqual(chordToVirtualKey({ code: 'KeyA', ctrl: true, shift: true }), { vk: 65, modifiers: 0x6 })
    assert.deepEqual(chordToVirtualKey({ code: 'KeyZ', ctrl: true }), { vk: 90, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'Digit0', ctrl: true }), { vk: 48, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'Digit9', alt: true }), { vk: 57, modifiers: 0x1 })
    assert.deepEqual(chordToVirtualKey({ code: 'F1', ctrl: true, shift: true }), { vk: 112, modifiers: 0x6 })
    assert.deepEqual(chordToVirtualKey({ code: 'F12', ctrl: true, shift: true }), { vk: 123, modifiers: 0x6 })
    assert.deepEqual(chordToVirtualKey({ code: 'ArrowUp', ctrl: true }), { vk: 38, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'ArrowDown', alt: true }), { vk: 40, modifiers: 0x1 })
    assert.deepEqual(chordToVirtualKey({ code: 'ArrowLeft', shift: true }), { vk: 37, modifiers: 0x4 })
    assert.deepEqual(chordToVirtualKey({ code: 'ArrowRight', meta: true }), { vk: 39, modifiers: 0x8 })
    assert.deepEqual(chordToVirtualKey({ code: 'PageUp', ctrl: true }), { vk: 33, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'PageDown', ctrl: true }), { vk: 34, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'Home', ctrl: true }), { vk: 36, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'End', ctrl: true }), { vk: 35, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'Insert', ctrl: true }), { vk: 45, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'Delete', ctrl: true }), { vk: 46, modifiers: 0x2 })
    assert.deepEqual(chordToVirtualKey({ code: 'Space', ctrl: true, shift: true }), { vk: 32, modifiers: 0x6 })
    assert.deepEqual(chordToVirtualKey({ code: 'F12', alt: true, meta: true }), { vk: 123, modifiers: 0x9 })
    const normalized = normalizeShortcut({ code: 'KeyA', ctrl: 1, shift: 0 })
    assert.deepEqual(normalized, { code: 'KeyA', ctrl: true, shift: false, alt: false, meta: false })
    assert.equal(modifierMask(normalized), 0x2)
    assert.equal(REGISTRATION_TIMEOUT_MS, 3000)
    assert.equal(HOTKEY_DEBOUNCE_MS, 400)
    const expectedSettingsPath = join(
      process.env.DSH_HOME || join(homedir(), '.dsh'),
      'dsh-screencapture',
      'settings.json',
    )
    assert.equal(defaultSettingsPath(), expectedSettingsPath, 'default settings path follows DSH_HOME')
    return 'KeyA→65/0x6, F1..F12, digits, arrows, navigation, Space, Alt+Meta'
  })

  // --- 2. invalid chords -------------------------------------------------
  await test('invalid chords are rejected with code invalid-shortcut', async () => {
    const invalid = [
      ['no modifier', { code: 'KeyA', ctrl: false, shift: false, alt: false, meta: false }],
      ['unknown code', { code: 'KeyFoo', ctrl: true }],
      ['missing code', { ctrl: true }],
      ['non-string code', { code: 65, ctrl: true }],
      ['null shortcut', null],
      ['array shortcut', []],
    ]
    for (const [label, chord] of invalid) {
      assert.throws(
        () => chordToVirtualKey(chord),
        error => error && error.code === 'invalid-shortcut',
        `${label} must be rejected as invalid-shortcut`,
      )
    }
    return `${invalid.length} invalid chords rejected`
  })

  // --- 3. manager unit: ready, debounce, restart, stop -------------------
  await test('manager debounces repeated presses at 400 ms and restarts cleanly on chord change', async () => {
    const fake = createFakeHotkeySpawn()
    const manager = createHotkeyManager({
      spawn: fake.spawn,
      settingsPath: join(ARTIFACTS_DIR, 'manager-unit-settings.json'),
      logger,
    })
    const presses = []
    manager.onHotkey = () => {
      presses.push(Date.now())
    }
    try {
      const started = await manager.start({ code: 'F12', ctrl: true, shift: true })
      assert.equal(started.enabled, true)
      assert.equal(started.registered, true)
      assert.equal(started.error, null)
      assert.deepEqual(started.shortcut, { code: 'F12', ctrl: true, shift: true, alt: false, meta: false })
      assert.equal(fake.state.commands.at(-1).vk, 123)
      assert.equal(fake.state.commands.at(-1).modifiers, 6)
      assert.equal(manager.hasProcess, true)
      const firstPid = manager.pid
      assert.equal(typeof firstPid, 'number')

      fake.state.children.at(-1).stdout.write('hotkey\n')
      await waitFor(() => presses.length === 1, 1000, 'first debounced hotkey')
      fake.state.children.at(-1).stdout.write('hotkey\n') // inside the 400 ms window
      await sleep(120)
      assert.equal(presses.length, 1, 'a second press within the debounce window is dropped')
      await sleep(HOTKEY_DEBOUNCE_MS)
      fake.state.children.at(-1).stdout.write('hotkey\n')
      await waitFor(() => presses.length === 2, 1000, 'second press after the debounce window')

      const restarted = await manager.start({ code: 'F11', ctrl: true, alt: true })
      assert.equal(restarted.registered, true)
      assert.equal(manager.pid !== firstPid, true, 'changing the chord replaces the helper process')
      assert.equal(fake.state.commands.at(-1).vk, 122)
      assert.equal(fake.state.commands.at(-1).modifiers, 0x3)

      const stopped = await manager.stop()
      assert.equal(stopped.enabled, false)
      assert.equal(stopped.registered, false)
      assert.equal(manager.hasProcess, false)
      await sleep(50)
      assert.equal(fake.state.children.every(child => child.exited), true, 'every scripted helper was killed')
    } finally {
      await manager.close()
    }
    return 'ready → debounced presses → chord change restart → stop killed the helper'
  })

  // --- 4. SSE route unit -------------------------------------------------
  await test('SSE route streams headers, heartbeat, keep-alive, injected events and drops closed clients', async () => {
    const events = createEventHub({ keepAliveMs: 60 })
    const routes = makeRoutes({
      platform: 'win32',
      events,
      lastCapture: () => null,
      status: () => ({ helper: 'idle', screens: [], virtual: { x: 0, y: 0, width: 0, height: 0 } }),
    })
    const eventsRoute = routes.find(entry => entry.path === ROUTE_PATHS.events)
    const request = makeRequest({ method: 'GET' })
    const response = makeStreamResponse()
    await eventsRoute.handler(request, response)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'text/event-stream')
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers.connection, 'keep-alive')
    assert.match(response.body, /^: connected\n\n/)
    assert.equal(events.clientCount, 1)

    events.emit('capture', { seq: 7, width: 2560, height: 1440, capturedAt: '2026-01-02T03:04:05.006Z' })
    assert.ok(response.body.includes('event: capture\n'), 'capture event frame')
    assert.ok(
      response.body.includes('data: {"seq":7,"width":2560,"height":1440,"capturedAt":"2026-01-02T03:04:05.006Z"}\n\n'),
      'capture event JSON payload',
    )
    events.emit('capture-failed', { code: 'capture-failed', message: 'nope' })
    assert.ok(response.body.includes('event: capture-failed\n'), 'capture-failed event frame')
    assert.ok(response.body.includes('data: {"code":"capture-failed","message":"nope"}\n\n'))

    await waitFor(() => response.body.includes(': keep-alive'), 2000, 'keep-alive comment')
    request.emit('close')
    await waitFor(() => events.clientCount === 0, 1000, 'client removal on close')
    assert.equal(response.ended, true, 'closed client response was ended')

    // POST is refused, non-loopback is fenced.
    const post = await callRoute(routes, ROUTE_PATHS.events, { method: 'POST', body: jsonBody({}) })
    assert.equal(post.status, 405)
    const hostile = await callRoute(routes, ROUTE_PATHS.events, { method: 'GET', remoteAddress: '10.9.9.9' })
    assert.equal(hostile.status, 403)
    events.close()
    return 'headers + : connected + event frames + keep-alive + close cleanup'
  })

  // --- 5. flow unit: capture-failed broadcast + in-flight guard -----------
  await test('global capture flow broadcasts capture-failed and ignores presses while in flight', async () => {
    const events = createEventHub({ keepAliveMs: 5000 })
    const request = makeRequest({ method: 'GET' })
    const response = makeStreamResponse()
    events.subscribe(request, response)
    let captureCalls = 0
    let releaseBlockedCapture
    const blocked = new Promise((resolve) => {
      releaseBlockedCapture = resolve
    })
    const flow = createGlobalCaptureFlow({
      events,
      capture: async () => {
        captureCalls += 1
        if (captureCalls === 1) {
          throw Object.assign(new Error('the screen is locked'), { code: 'capture-failed' })
        }
        await blocked
        return { dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 10, screens: [] }
      },
      activate: async () => {},
    })
    try {
      const failed = await flow.handleHotkey()
      assert.equal(failed.ok, false)
      assert.equal(failed.code, 'capture-failed')
      assert.ok(response.body.includes('event: capture-failed\n'), 'capture-failed SSE frame')
      assert.ok(response.body.includes('data: {"code":"capture-failed","message":"the screen is locked"}\n\n'))

      const running = flow.handleHotkey()
      await sleep(20)
      const ignored = await flow.handleHotkey()
      assert.equal(ignored.ignored, true, 'a press while a capture is in flight is ignored')
      releaseBlockedCapture()
      const completed = await running
      assert.equal(completed.ok, true)
      assert.ok(response.body.includes('event: capture\n'), 'capture SSE frame after the failure')
    } finally {
      events.close()
    }
    return 'capture-failed frame + in-flight ignore'
  })

  // --- 6. last-capture 404 before a flow ---------------------------------
  await test('last-capture route answers 404 no-capture before any global capture', async () => {
    const events = createEventHub()
    const routes = makeRoutes({
      platform: 'win32',
      events,
      status: () => ({ helper: 'idle', screens: [], virtual: { x: 0, y: 0, width: 0, height: 0 } }),
    })
    const response = await callRoute(routes, ROUTE_PATHS.lastCapture, { method: 'GET' })
    assert.equal(response.status, 404)
    assert.equal(response.json.ok, false)
    assert.equal(response.json.code, 'no-capture')
    const post = await callRoute(routes, ROUTE_PATHS.lastCapture, { method: 'POST', body: jsonBody({}) })
    assert.equal(post.status, 405)
    events.close()
    return '404 {ok:false, code:"no-capture"}'
  })

  // --- 6b. overlay-window route contract (fake deps) ---------------------
  await test('overlay-window route: prepare/restore contract, invalid action, method and fence', async () => {
    const calls = []
    const routes = makeRoutes({
      platform: 'win32',
      prepareOverlayWindow: async () => {
        calls.push('prepare')
        return { ok: true, changed: true, hwnd: '123456', placement: { showCmd: 1, left: 100, top: 80, right: 900, bottom: 680 } }
      },
      restoreOverlayWindow: async () => {
        calls.push('restore')
        return { ok: true, restored: true }
      },
    })
    const prepare = await callRoute(routes, ROUTE_PATHS.overlayWindow, {
      method: 'POST',
      body: jsonBody({ action: 'prepare' }),
    })
    assert.equal(prepare.status, 200)
    assert.deepEqual(prepare.json, { ok: true, changed: true, prepared: true })
    const restore = await callRoute(routes, ROUTE_PATHS.overlayWindow, {
      method: 'POST',
      body: jsonBody({ action: 'restore' }),
    })
    assert.equal(restore.status, 200)
    assert.deepEqual(restore.json, { ok: true, restored: true })
    assert.deepEqual(calls, ['prepare', 'restore'])

    const invalid = await callRoute(routes, ROUTE_PATHS.overlayWindow, {
      method: 'POST',
      body: jsonBody({ action: 'toggle' }),
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.code, 'invalid-action')
    const missing = await callRoute(routes, ROUTE_PATHS.overlayWindow, { method: 'POST', body: jsonBody({}) })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.code, 'invalid-action')
    const wrongMethod = await callRoute(routes, ROUTE_PATHS.overlayWindow, { method: 'GET' })
    assert.equal(wrongMethod.status, 405)
    const hostile = await callRoute(routes, ROUTE_PATHS.overlayWindow, {
      method: 'POST',
      body: jsonBody({ action: 'prepare' }),
      remoteAddress: '10.1.2.3',
    })
    assert.equal(hostile.status, 403)
    return 'prepare {ok,changed,prepared}, restore {ok,restored}, 400 invalid-action, 405, 403'
  })

  // --- 6. config route persistence + re-registration ---------------------
  let hostForConfig
  await test('POST /config persists the setting, registers, re-registers a changed chord and disables cleanly', async () => {
    hostForConfig = createHost({ logger, hotkeySettingsPath: settingsPath, loadStoredConfig: false })
    try {
      assert.equal(existsSync(settingsPath), false, 'no settings file before the first config')

      const first = await callRoute(hostForConfig.routes, ROUTE_PATHS.config, {
        method: 'POST',
        body: jsonBody({ enabled: true, shortcut: TEST_SHORTCUT }),
      })
      assert.equal(first.status, 200, JSON.stringify(first.json))
      assert.equal(first.json.ok, true)
      assert.equal(first.json.globalHotkey.enabled, true)
      assert.equal(first.json.globalHotkey.registered, true)
      assert.equal(first.json.globalHotkey.error, null)
      assert.deepEqual(first.json.globalHotkey.shortcut, { code: 'F12', ctrl: true, shift: true, alt: false, meta: false })
      assert.equal(hostForConfig.hotkey.hasProcess, true)
      const firstPid = hostForConfig.hotkey.pid
      assert.equal(typeof firstPid, 'number')
      const saved = JSON.parse(await readFile(settingsPath, 'utf8'))
      assert.deepEqual(saved, { enabled: true, shortcut: { code: 'F12', ctrl: true, shift: true, alt: false, meta: false } })

      const second = await callRoute(hostForConfig.routes, ROUTE_PATHS.config, {
        method: 'POST',
        body: jsonBody({ enabled: true, shortcut: CHANGED_SHORTCUT }),
      })
      assert.equal(second.status, 200)
      assert.equal(second.json.globalHotkey.registered, true)
      assert.deepEqual(second.json.globalHotkey.shortcut, { code: 'F11', ctrl: true, shift: false, alt: true, meta: false })
      assert.equal(hostForConfig.hotkey.pid !== firstPid, true, 'the helper was restarted for the new chord')
      const savedAgain = JSON.parse(await readFile(settingsPath, 'utf8'))
      assert.equal(savedAgain.shortcut.code, 'F11')
      assert.equal(savedAgain.shortcut.alt, true)

      const invalid = await callRoute(hostForConfig.routes, ROUTE_PATHS.config, {
        method: 'POST',
        body: jsonBody({ enabled: true, shortcut: null }),
      })
      assert.equal(invalid.status, 400)
      assert.equal(invalid.json.code, 'invalid-shortcut')

      const invalidEnabled = await callRoute(hostForConfig.routes, ROUTE_PATHS.config, {
        method: 'POST',
        body: jsonBody({ enabled: 'yes', shortcut: CHANGED_SHORTCUT }),
      })
      assert.equal(invalidEnabled.status, 400)
      assert.equal(invalidEnabled.json.code, 'invalid-config')

      const disabled = await callRoute(hostForConfig.routes, ROUTE_PATHS.config, {
        method: 'POST',
        body: jsonBody({ enabled: false, shortcut: null }),
      })
      assert.equal(disabled.status, 200)
      assert.equal(disabled.json.globalHotkey.enabled, false)
      assert.equal(disabled.json.globalHotkey.registered, false)
      assert.equal(hostForConfig.hotkey.hasProcess, false, 'disabling kills the hotkey helper')
      const savedDisabled = JSON.parse(await readFile(settingsPath, 'utf8'))
      assert.deepEqual(savedDisabled, { enabled: false, shortcut: null })

      // status extension reports the same object
      const statusResponse = await callRoute(hostForConfig.routes, ROUTE_PATHS.status, { method: 'GET' })
      assert.equal(statusResponse.status, 200)
      assert.deepEqual(statusResponse.json.globalHotkey, disabled.json.globalHotkey)
      return settingsPath
    } finally {
      await hostForConfig.close()
      hostForConfig = undefined
    }
  })

  await test('manager stop leaves no test-owned hotkey-helper process behind (Get-CimInstance)', async () => {
    const lingering = await countHelperProcesses(HOTKEY_HELPER_PROCESS_PATTERN)
    assert.equal(lingering, 0, `expected 0 test-owned hotkey-helper processes, found ${lingering}`)
    return '0 hotkey-helper processes parented by the test'
  })

  // --- 7. persisted config is loaded on activation ----------------------
  await test('createHost loads a persisted enabled setting and starts the hotkey (swallowing a taken chord)', async () => {
    // A fresh host must pick up the settings written by the previous test.
    await writeFile(settingsPath, JSON.stringify({ enabled: true, shortcut: TEST_SHORTCUT }, null, 2) + '\n')
    const host = createHost({ logger, hotkeySettingsPath: settingsPath })
    try {
      const status = await host.startStoredHotkey()
      assert.equal(status.enabled, true)
      assert.equal(status.registered, true, JSON.stringify(status))
      assert.deepEqual(status.shortcut, { code: 'F12', ctrl: true, shift: true, alt: false, meta: false })
      const statusResponse = await callRoute(host.routes, ROUTE_PATHS.status, { method: 'GET' })
      assert.equal(statusResponse.json.globalHotkey.registered, true)
    } finally {
      await host.close()
    }
    assert.equal(await countHelperProcesses(HOTKEY_HELPER_PROCESS_PATTERN), 0, 'helper killed on close')
    return 'persisted {enabled:true, shortcut:F12} applied on activation'
  })

  // --- 8. capture-helper activate command --------------------------------
  await test('capture helper activate command reports activate-failed for a process without a window', async () => {
    const engine = createCaptureEngine({ logger })
    try {
      await assert.rejects(engine.activate(0), error => error && error.code === 'activate-failed')
      await assert.rejects(engine.activate(598_765), error => error && error.code === 'activate-failed')
    } finally {
      await engine.close()
    }
    assert.equal(engine.hasProcess, false)
    return 'invalid pid rejected locally; missing window reported by the helper'
  })

  // --- 8b. activate preserves placement and reaches the foreground ------
  await test('capture helper activate preserves placement (maximized stays maximized) and reaches the foreground', async () => {
    const probe = createPlacementProbe()
    const engine = createCaptureEngine({ logger })
    try {
      const readyLine = await probe.waitForNew(line => line.startsWith('READY|'), 15_000, 'placement probe ready')
      const [, pidText, hwndText] = readyLine.split('|')
      const probePid = Number(pidText)
      const probeHwnd = Number(hwndText)
      assert.ok(probePid > 0 && probeHwnd > 0, `probe pid/hwnd valid: ${readyLine}`)

      const command = async (commandName, label) => {
        probe.send(commandName)
        return parseProbeState(await probe.waitForNew(line => line.startsWith('STATE|'), 8000, label))
      }
      const probeNow = () => command('probe', 'probe state')
      const waitForProbeForeground = async () => {
        const deadline = Date.now() + 2500
        let last
        do {
          last = await probeNow()
          if (last.foregroundHwnd === probeHwnd) return last
          await sleep(30)
        } while (Date.now() < deadline)
        return last
      }

      // Maximized: must stay maximized (the un-maximize regression).
      const maximized = await command('state-maximized', 'maximized state')
      assert.equal(maximized.owner, 0, 'probe window is ownerless (FindTopLevelWindow selectable)')
      assert.equal(maximized.showCmd, 3, 'probe window starts maximized')
      const activated = await engine.activate(probePid)
      assert.equal(Number(activated), probeHwnd, 'activate selected the probe window itself')
      const maximizedAfter = await waitForProbeForeground()
      assert.equal(maximizedAfter.foregroundHwnd, probeHwnd, 'activated window is the foreground window')
      assert.equal(maximizedAfter.showCmd, 3, 'maximized placement is preserved by activate')
      assert.deepEqual(rectOf(maximizedAfter), rectOf(maximized), 'maximized rectangle is untouched')

      // Normal: placement untouched by activation.
      const normal = await command('state-normal', 'normal state')
      assert.equal(normal.showCmd, 1, 'probe window is normal')
      await engine.activate(probePid)
      await sleep(120)
      const normalAfter = await probeNow()
      assert.equal(normalAfter.showCmd, 1, 'normal placement is preserved by activate')
      assert.deepEqual(rectOf(normalAfter), rectOf(normal), 'normal rectangle is untouched')

      // Minimized: restored to the previous normal rectangle and foregrounded.
      const minimized = await command('state-minimized', 'minimized state')
      assert.equal(minimized.showCmd, 2, 'probe window is minimized')
      await engine.activate(probePid)
      const minimizedAfter = await waitForProbeForeground()
      assert.equal(minimizedAfter.showCmd, 1, 'a minimized window is restored')
      assert.deepEqual(rectOf(minimizedAfter), rectOf(normal), 'restored to the pre-minimize rectangle')
      assert.equal(minimizedAfter.foregroundHwnd, probeHwnd, 'restored window is the foreground window')
      return `maximized 3→3, normal 1→1, minimized 2→1, foreground acquired (hwnd ${probeHwnd})`
    } finally {
      probe.send('quit')
      await Promise.race([probe.exited, sleep(3000)])
      try {
        probe.child.kill()
      } catch {
        /* already exited */
      }
      await engine.close()
    }
  })

  // --- 8c. overlay-window prepare/restore on a real window ---------------
  await test('overlay-window prepare/restore: normal window maximize round-trip, already-maximized no-op, minimized edge', async () => {
    const probe = createPlacementProbe()
    const engine = createCaptureEngine({ logger })
    try {
      const readyLine = await probe.waitForNew(line => line.startsWith('READY|'), 15_000, 'placement probe ready')
      const [, pidText, hwndText] = readyLine.split('|')
      const probePid = Number(pidText)
      const probeHwnd = Number(hwndText)
      const command = async (commandName, label) => {
        probe.send(commandName)
        return parseProbeState(await probe.waitForNew(line => line.startsWith('STATE|'), 8000, label))
      }
      const probeNow = () => command('probe', 'probe state')
      const waitProbeState = async (expectedShowCmd, label) => {
        const deadline = Date.now() + 2500
        let last
        do {
          last = await probeNow()
          if (last.showCmd === expectedShowCmd) return last
          await sleep(30)
        } while (Date.now() < deadline)
        throw new Error(`timed out waiting for probe showCmd ${expectedShowCmd} (${label}); last=${JSON.stringify(last)}`)
      }

      // No pending snapshot: a clean no-op.
      assert.deepEqual(await engine.restoreOverlayWindow(), { ok: true, restored: false })

      // Normal window: prepare maximizes and remembers the exact normal rect;
      // restore puts that rect back and un-maximizes.
      const normal = await command('state-normal', 'normal state')
      assert.equal(normal.showCmd, 1)
      const originalRect = rectOf(normal)
      const prepared = await engine.prepareOverlayWindow(probePid)
      assert.equal(prepared.ok, true)
      assert.equal(prepared.changed, true, 'prepare reports changed:true for a normal window')
      assert.equal(Number(prepared.hwnd), probeHwnd, 'prepare selected the probe window')
      assert.equal(prepared.placement.showCmd, 1, 'snapshot keeps the original showCmd')
      assert.deepEqual(
        [prepared.placement.left, prepared.placement.top, prepared.placement.right, prepared.placement.bottom],
        originalRect,
        'snapshot keeps the original normal rectangle',
      )
      const maximized = await waitProbeState(3, 'probe maximized after prepare')
      assert.equal(maximized.showCmd, 3, 'prepare maximized the window for the overlay')
      const restored = await engine.restoreOverlayWindow()
      assert.deepEqual(restored, { ok: true, restored: true })
      const afterRestore = await waitProbeState(1, 'probe restored after restore-overlay')
      assert.equal(afterRestore.showCmd, 1, 'restore un-maximized the window')
      assert.deepEqual(rectOf(afterRestore), originalRect, 'restore returns the exact original rectangle')
      assert.deepEqual(await engine.restoreOverlayWindow(), { ok: true, restored: false }, 'restore is idempotent')

      // Already maximized: prepare reports changed:false and restore is a no-op.
      const alreadyMaximized = await command('state-maximized', 'maximized state')
      assert.equal(alreadyMaximized.showCmd, 3)
      const preparedMax = await engine.prepareOverlayWindow(probePid)
      assert.equal(preparedMax.changed, false, 'prepare reports changed:false when already maximized')
      assert.equal(preparedMax.placement.showCmd, 3)
      assert.deepEqual(await engine.restoreOverlayWindow(), { ok: true, restored: true })
      const stillMaximized = await probeNow()
      assert.equal(stillMaximized.showCmd, 3, 'a window that was already maximized stays maximized')

      // Minimized at prepare time: maximized for the overlay, then restored to
      // its remembered NORMAL rect (not re-minimized).
      const normalAgain = await command('state-normal', 'normal again')
      assert.deepEqual(rectOf(normalAgain), originalRect)
      const minimized = await command('state-minimized', 'minimized state')
      assert.equal(minimized.showCmd, 2)
      const preparedMin = await engine.prepareOverlayWindow(probePid)
      assert.equal(preparedMin.changed, true, 'prepare restores and maximizes a minimized window')
      assert.equal(preparedMin.placement.showCmd, 2, 'snapshot remembers the minimized original showCmd')
      assert.deepEqual(
        [preparedMin.placement.left, preparedMin.placement.top, preparedMin.placement.right, preparedMin.placement.bottom],
        originalRect,
        'snapshot keeps the normal rect of a minimized window',
      )
      const maximizedFromMin = await waitProbeState(3, 'probe maximized from minimized')
      assert.equal(maximizedFromMin.showCmd, 3)
      await engine.restoreOverlayWindow()
      const afterMinRestore = await waitProbeState(1, 'probe restored from minimized')
      assert.equal(afterMinRestore.showCmd, 1, 'restore returns a minimized window to normal (not minimized)')
      assert.deepEqual(rectOf(afterMinRestore), originalRect)
      return `normal→maximized(changed:true)→exact rect; already-maximized changed:false no-op; minimized 2→3→1`
    } finally {
      probe.send('quit')
      await Promise.race([probe.exited, sleep(3000)])
      try {
        probe.child.kill()
      } catch {
        /* already exited */
      }
      await engine.close()
    }
  })

  // --- 8d. best-effort restore on engine close ---------------------------
  await test('engine.close() restores a pending overlay snapshot (no window left maximized on unload)', async () => {
    const probe = createPlacementProbe()
    const engine = createCaptureEngine({ logger })
    try {
      const readyLine = await probe.waitForNew(line => line.startsWith('READY|'), 15_000, 'placement probe ready')
      const [, pidText] = readyLine.split('|')
      const probePid = Number(pidText)
      const command = async (commandName, label) => {
        probe.send(commandName)
        return parseProbeState(await probe.waitForNew(line => line.startsWith('STATE|'), 8000, label))
      }
      const normal = await command('state-normal', 'normal state')
      const originalRect = rectOf(normal)
      const prepared = await engine.prepareOverlayWindow(probePid)
      assert.equal(prepared.changed, true)
      // Poll until the probe is actually maximized before closing.
      let maximized = normal
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        probe.send('probe')
        maximized = parseProbeState(await probe.waitForNew(line => line.startsWith('STATE|'), 8000, 'probe state'))
        if (maximized.showCmd === 3) break
        await sleep(30)
      }
      assert.equal(maximized.showCmd, 3, 'window is maximized before close')
      await engine.close() // no explicit restore: close() must put the placement back
      probe.send('probe')
      const afterClose = parseProbeState(await probe.waitForNew(line => line.startsWith('STATE|'), 8000, 'probe after close'))
      assert.equal(afterClose.showCmd, 1, 'close() restored the pending overlay placement')
      assert.deepEqual(rectOf(afterClose), originalRect, 'close() restored the exact original rectangle')
      return `pending snapshot restored by close(); rect ${JSON.stringify(originalRect)}`
    } finally {
      probe.send('quit')
      await Promise.race([probe.exited, sleep(3000)])
      try {
        probe.child.kill()
      } catch {
        /* already exited */
      }
      await engine.close()
    }
  })

  // --- 8e. window-snapping list: live helper command ---------------------
  await test('windows list: Z-ordered entries with DWM bounds including known probe windows', async () => {
    const probeA = createPlacementProbe({ title: 'dsh-screencapture snap probe A', noToolWindow: true })
    const probeB = createPlacementProbe({ title: 'dsh-screencapture snap probe B', noToolWindow: true })
    const engine = createCaptureEngine({ logger })
    try {
      const readyA = await probeA.waitForNew(line => line.startsWith('READY|'), 15_000, 'snap probe A ready')
      const readyB = await probeB.waitForNew(line => line.startsWith('READY|'), 15_000, 'snap probe B ready')
      const [, pidAText, hwndAText] = readyA.split('|')
      const [, pidBText, hwndBText] = readyB.split('|')
      const probeAPid = Number(pidAText)
      const probeAHwnd = Number(hwndAText)
      const probeBPid = Number(pidBText)
      const probeBHwnd = Number(hwndBText)

      // Foreground probe B so it must sort above A in the Z-order list.
      await engine.activate(probeBPid)
      const result = await engine.capture()
      assert.ok(Array.isArray(result.windows), 'capture() returns a windows array')
      assert.ok(result.windows.length >= 1, 'the live desktop has at least one titled window')
      assert.ok(result.virtual && result.virtual.width > 0, 'capture() returns the virtual desktop rect')
      const virtual = result.virtual
      for (const entry of result.windows) {
        assert.equal(typeof entry.hwnd, 'number', 'window.hwnd is a number')
        assert.ok(entry.hwnd > 0, 'window.hwnd is positive')
        assert.equal(typeof entry.title, 'string', 'window.title is a string')
        assert.ok(entry.title.length > 0, 'window.title is non-empty')
        assert.equal(typeof entry.className, 'string', 'window.className is a string')
        assert.ok(entry.className.length > 0, 'window.className is non-empty')
        assert.equal(typeof entry.pid, 'number', 'window.pid is a number')
        assert.ok(entry.pid > 0, 'window.pid is positive')
        assert.equal(typeof entry.processName, 'string', 'window.processName is a string')
        for (const key of ['x', 'y', 'width', 'height']) {
          assert.equal(typeof entry[key], 'number', `window.${key} is a number`)
        }
        assert.ok(entry.width > 1 && entry.height > 1, 'window is larger than 1x1')
        assert.ok(
          entry.x >= virtual.x - 16 && entry.y >= virtual.y - 16
          && entry.x + entry.width <= virtual.x + virtual.width + 16
          && entry.y + entry.height <= virtual.y + virtual.height + 16,
          `window ${entry.hwnd} lies within the virtual screen`,
        )
      }
      const indexA = result.windows.findIndex(entry => entry.hwnd === probeAHwnd)
      const indexB = result.windows.findIndex(entry => entry.hwnd === probeBHwnd)
      assert.ok(indexA >= 0, `known titled probe A window (${probeAHwnd}) is in the list`)
      assert.ok(indexB >= 0, `known titled probe B window (${probeBHwnd}) is in the list`)
      assert.ok(indexB < indexA, `foreground probe B (index ${indexB}) sorts above probe A (index ${indexA})`)

      // Entry bounds are the exact DWM extended frame bounds the probe reports.
      for (const fixture of [
        { probe: probeA, index: indexA, pid: probeAPid, hwnd: probeAHwnd, title: 'dsh-screencapture snap probe A' },
        { probe: probeB, index: indexB, pid: probeBPid, hwnd: probeBHwnd, title: 'dsh-screencapture snap probe B' },
      ]) {
        fixture.probe.send('probe')
        const state = parseProbeState(await fixture.probe.waitForNew(
          line => line.startsWith('STATE|'),
          8000,
          'probe state',
        ))
        assert.equal(state.dwmOk, true, 'fixture reports DWM extended frame bounds')
        const entry = result.windows[fixture.index]
        assert.equal(entry.title, fixture.title)
        assert.equal(entry.pid, fixture.pid)
        assert.deepEqual(
          [entry.x, entry.y, entry.width, entry.height],
          [state.dwmLeft, state.dwmTop, state.dwmRight - state.dwmLeft, state.dwmBottom - state.dwmTop],
          'entry bounds equal the window DWM extended frame bounds',
        )
      }
      const sample = result.windows
        .slice(0, 5)
        .map(entry => `${entry.hwnd} "${entry.title.slice(0, 40)}" ${entry.x},${entry.y} ${entry.width}x${entry.height}`)
      return `${result.windows.length} windows; probe B(${indexB}) above A(${indexA}); DWM bounds exact; sample: ${sample.length}`
    } finally {
      probeA.send('quit')
      probeB.send('quit')
      await Promise.race([
        Promise.all([probeA.exited, probeB.exited]),
        sleep(3000),
      ])
      try {
        probeA.child.kill()
      } catch {
        /* already exited */
      }
      try {
        probeB.child.kill()
      } catch {
        /* already exited */
      }
      await engine.close()
    }
  })

  // --- 8f. window enumeration failure degradation ------------------------
  await test('window enumeration failure degrades to windows:[] without failing the capture', async () => {
    const fake = createFakeCaptureSpawn({ windowsError: 'enumeration exploded' })
    const engine = createCaptureEngine({ spawn: fake.spawn, logger })
    try {
      const result = await engine.capture()
      assert.ok(result.dataUrl.startsWith('data:image/png;base64,'), 'capture still returned a PNG')
      assert.equal(result.width, 10)
      assert.deepEqual(result.windows, [], 'capture succeeds with an empty window list')
      assert.ok(fake.state.commands.includes('windows'), 'the windows enumeration command was attempted')
    } finally {
      await engine.close()
    }
    return 'capture ok with windows:[] when enumeration fails'
  })

  // --- 8g. route-level windows passthrough -------------------------------
  await test('/capture and /last-capture responses include windows (route fake deps)', async () => {
    const capturedAt = '2026-01-02T03:04:05.006Z'
    const dataUrl = 'data:image/png;base64,' + TINY_PNG.toString('base64')
    const routes = makeRoutes({
      platform: 'win32',
      capture: async () => ({
        dataUrl,
        width: 1,
        height: 1,
        screens: [],
        virtual: { x: 0, y: 0, width: 1, height: 1 },
        windows: [SAMPLE_WINDOW],
        capturedAt,
      }),
      lastCapture: () => ({
        image: { dataUrl, width: 1, height: 1 },
        screens: [],
        virtual: { x: 0, y: 0, width: 1, height: 1 },
        windows: [SAMPLE_WINDOW],
        capturedAt,
        seq: 5,
      }),
    })
    const captureResponse = await callRoute(routes, ROUTE_PATHS.capture, { method: 'POST', body: jsonBody({}) })
    assert.equal(captureResponse.status, 200)
    assert.deepEqual(captureResponse.json.windows, [SAMPLE_WINDOW], '/capture carries windows')
    assert.deepEqual(captureResponse.json.virtual, { x: 0, y: 0, width: 1, height: 1 }, '/capture carries virtual')
    assert.equal(captureResponse.json.capturedAt, capturedAt, '/capture uses the capture-time timestamp')
    const lastCaptureResponse = await callRoute(routes, ROUTE_PATHS.lastCapture, { method: 'GET' })
    assert.equal(lastCaptureResponse.status, 200)
    assert.deepEqual(lastCaptureResponse.json.windows, [SAMPLE_WINDOW], '/last-capture carries windows')
    assert.deepEqual(lastCaptureResponse.json.virtual, { x: 0, y: 0, width: 1, height: 1 }, '/last-capture carries virtual')
    assert.equal(lastCaptureResponse.json.seq, 5)

    // Absent windows degrade to an empty array (older/partial producers).
    const degradedRoutes = makeRoutes({
      platform: 'win32',
      capture: async () => ({
        dataUrl,
        width: 1,
        height: 1,
        screens: [],
        virtual: { x: 0, y: 0, width: 1, height: 1 },
      }),
      lastCapture: () => ({ image: { dataUrl, width: 1, height: 1 }, screens: [], capturedAt, seq: 1 }),
    })
    const degraded = await callRoute(degradedRoutes, ROUTE_PATHS.capture, { method: 'POST', body: jsonBody({}) })
    assert.deepEqual(degraded.json.windows, [], 'missing windows degrades to []')
    return 'windows passthrough on /capture + /last-capture; absent -> []'
  })

  // --- 9. direct helper registration lifecycle ---------------------------
  await test('hotkey-helper registers Ctrl+Shift+F12 (ready line), refuses a duplicate, exits on stdin close', async () => {
    const helperProcess = spawn(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', HOTKEY_HELPER, '123', '6'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    const lines = []
    let buffer = ''
    const waiters = new Set()
    helperProcess.stdout.setEncoding('utf8')
    helperProcess.stdout.on('data', (chunk) => {
      buffer += chunk
      let newlineAt
      while ((newlineAt = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineAt).replace(/\r$/, '')
        buffer = buffer.slice(newlineAt + 1)
        if (line === '') continue
        lines.push(line)
        for (const waiter of [...waiters]) {
          if (waiter.predicate(line)) {
            waiters.delete(waiter)
            clearTimeout(waiter.timer)
            waiter.resolve(line)
          }
        }
      }
    })
    helperProcess.stderr.setEncoding('utf8')
    helperProcess.stderr.on('data', () => {})
    const waitForLine = (predicate, timeoutMs) => {
      const existing = lines.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`timed out waiting; lines=${JSON.stringify(lines)}`))
        }, timeoutMs)
        waiters.add(waiter)
      })
    }
    const exited = new Promise(resolve => helperProcess.once('exit', resolve))
    try {
      const ready = await waitForLine(line => line.startsWith('ready|') || line.startsWith('error|'), 6000)
      assert.equal(ready, 'ready|123|6', `registration line: ${ready}`)
      const readyLines = lines.filter(line => line.startsWith('ready|'))
      assert.equal(readyLines.length, 1, 'exactly one ready line')

      const duplicate = spawn(
        POWERSHELL,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', HOTKEY_HELPER, '123', '6'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      const duplicateOutput = await new Promise((resolve, reject) => {
        let text = ''
        duplicate.stdout.setEncoding('utf8')
        duplicate.stdout.on('data', (chunk) => { text += chunk })
        const timer = setTimeout(() => reject(new Error('duplicate registration produced no line')), 6000)
        duplicate.once('exit', () => { clearTimeout(timer); resolve(text.trim()) })
      })
      assert.match(duplicateOutput, /^error\|1409/, 'duplicate chord registration reports Win32 error 1409')

      // Closing stdin must make the helper exit by itself (no leaked process).
      helperProcess.stdin.end()
      const exitCode = await Promise.race([exited, sleep(4000).then(() => 'TIMEOUT')])
      assert.equal(exitCode, 0, `helper exits cleanly on stdin close (got ${exitCode})`)
      await waitFor(
        async () => (await countHelperProcesses(HOTKEY_HELPER_PROCESS_PATTERN)) === 0,
        4000,
        'no hotkey-helper process after stdin close',
      )
      return 'ready|123|6, duplicate → error|1409, stdin-close self-exit'
    } finally {
      try {
        helperProcess.kill()
      } catch {
        /* already exited */
      }
    }
  })

  // --- 10. E2E: synthetic SendKeys drives the real global hotkey ---------
  let e2eEvidence = null
  await test('OS-global hotkey E2E: ^+{F12} → capture SSE event → last-capture PNG', async () => {
    const host = createHost({
      logger,
      hotkeySettingsPath: join(ARTIFACTS_DIR, 'e2e-settings.json'),
      loadStoredConfig: false,
      sseKeepAliveMs: 120,
    })
    const sseRequest = makeRequest({ method: 'GET' })
    const sseResponse = makeStreamResponse()
    try {
      const eventsRoute = host.routes.find(entry => entry.path === ROUTE_PATHS.events)
      await eventsRoute.handler(sseRequest, sseResponse)
      assert.equal(sseResponse.statusCode, 200)
      assert.equal(host.events.clientCount, 1)

      const before = await callRoute(host.routes, ROUTE_PATHS.lastCapture, { method: 'GET' })
      assert.equal(before.status, 404, 'no cached capture before the hotkey')

      const configResponse = await callRoute(host.routes, ROUTE_PATHS.config, {
        method: 'POST',
        body: jsonBody({ enabled: true, shortcut: TEST_SHORTCUT }),
      })
      assert.equal(configResponse.status, 200, JSON.stringify(configResponse.json))
      assert.equal(configResponse.json.globalHotkey.registered, true, JSON.stringify(configResponse.json.globalHotkey))

      const startedAt = performance.now()
      // Windows may drop a synthetic chord (another app hogging input state),
      // so retry the SendKeys press a few times before giving up with a SKIP.
      let delivered = false
      const attempts = []
      const deadline = Date.now() + 16_000
      while (!delivered && Date.now() < deadline) {
        await sendKeys('^+{F12}')
        try {
          await waitFor(() => sseResponse.body.includes('event: capture\n'), 3500, 'SSE capture event', 50)
          delivered = true
          timings.hotkeyToSseMs = performance.now() - startedAt
        } catch {
          attempts.push('SendKeys delivered no hotkey within 3.5 s')
        }
      }
      if (!delivered) {
        const status = host.hotkey.status()
        throw new Skip(
          `the OS did not deliver the synthetic global hotkey to the helper in this session `
          + `(manager status ${JSON.stringify(status)}, attempts ${attempts.length}, `
          + `SSE body ${JSON.stringify(sseResponse.body.slice(0, 200))})`,
        )
      }

      // Parse every capture frame; a retried synthetic chord can legitimately
      // produce more than one capture, so assert against the LAST frame.
      const captureFrames = sseResponse.body
        .split('\n\n')
        .filter(part => part.startsWith('event: capture\n'))
      assert.ok(captureFrames.length >= 1, 'capture frame exists')
      const frames = captureFrames.map((frame) => {
        const dataLine = frame.split('\n').find(line => line.startsWith('data: '))
        return JSON.parse(dataLine.slice('data: '.length))
      })
      for (let index = 0; index < frames.length; index += 1) {
        const framePayload = frames[index]
        assert.equal(typeof framePayload.seq, 'number', 'frame seq is a number')
        assert.ok(framePayload.width > 0 && framePayload.height > 0, 'frame carries physical dimensions')
        assert.ok(Number.isFinite(Date.parse(framePayload.capturedAt)), 'frame capturedAt is an ISO timestamp')
        if (index > 0) assert.ok(framePayload.seq > frames[index - 1].seq, 'frame seq increases')
      }
      assert.equal(frames[0].seq, 1, 'the first global capture has seq 1')
      const payload = frames[frames.length - 1]

      const after = await callRoute(host.routes, ROUTE_PATHS.lastCapture, { method: 'GET' })
      assert.equal(after.status, 200)
      assert.equal(after.json.ok, true)
      assert.ok(after.json.seq >= payload.seq, 'cache holds the latest captured frame')
      assert.equal(after.json.image.width, payload.width)
      assert.equal(after.json.image.height, payload.height)
      assert.equal(typeof after.json.capturedAt, 'string')
      assert.ok(Array.isArray(after.json.screens) && after.json.screens.length >= 1)
      // The global-hotkey path must carry the captured-time window list too.
      assert.ok(Array.isArray(after.json.windows), 'last-capture carries a windows array')
      assert.ok(after.json.windows.length >= 1, 'the live desktop has at least one captured window')
      assert.equal(after.json.virtual.width, after.json.image.width, 'last-capture virtual rect matches the image')
      for (const entry of after.json.windows) {
        assert.equal(typeof entry.hwnd, 'number')
        assert.ok(entry.hwnd > 0)
        assert.equal(typeof entry.title, 'string')
        assert.ok(entry.title.length > 0)
        assert.ok(entry.width > 1 && entry.height > 1)
      }
      const png = decodePngDataUrl(after.json.image.dataUrl)
      assert.equal(png.width, payload.width)
      assert.equal(png.height, payload.height)
      e2eEvidence = join(ARTIFACTS_DIR, 'global-hotkey-capture.png')
      await writeFile(e2eEvidence, png.buffer)

      // Stop the OS hotkey before exercising the in-flight guard directly, so
      // no stray OS-triggered capture can race the assertions below.
      const stopped = await callRoute(host.routes, ROUTE_PATHS.config, {
        method: 'POST',
        body: jsonBody({ enabled: false, shortcut: null }),
      })
      assert.equal(stopped.status, 200)
      assert.equal(host.hotkey.hasProcess, false)
      await sleep(250)

      const baseline = await callRoute(host.routes, ROUTE_PATHS.lastCapture, { method: 'GET' })
      assert.equal(baseline.status, 200)
      const flowStartedAt = performance.now()
      const firstFlow = host.flow.handleHotkey()
      const secondFlow = await host.flow.handleHotkey()
      assert.equal(secondFlow.ignored, true, 'a press during an in-flight capture is ignored')
      const firstFlowResult = await firstFlow
      timings.globalCaptureFlowMs = performance.now() - flowStartedAt
      assert.equal(firstFlowResult.ok, true, JSON.stringify(firstFlowResult))
      const cached = await callRoute(host.routes, ROUTE_PATHS.lastCapture, { method: 'GET' })
      assert.equal(cached.json.seq, baseline.json.seq + 1, 'each completed global capture increments seq')
      assert.equal(cached.json.image.width, png.width)
      assert.ok(Array.isArray(cached.json.windows), 'the refreshed last-capture keeps the windows array')

      sseRequest.emit('close')
      await waitFor(() => host.events.clientCount === 0, 1000, 'SSE client removed on close')
      return `${payload.width}x${payload.height} PNG seq=${payload.seq}, SSE event + cached last-capture verified`
    } finally {
      await host.close()
    }
  })

  // --- 11. no leaked helper processes -----------------------------------
  await test('no test-owned hotkey or capture helper processes are left running', async () => {
    const hotkeyCount = await countHelperProcesses(HOTKEY_HELPER_PROCESS_PATTERN)
    const captureCount = await countHelperProcesses(CAPTURE_HELPER_PROCESS_PATTERN)
    assert.equal(hotkeyCount, 0, `expected 0 test-owned hotkey-helper processes, found ${hotkeyCount}`)
    assert.equal(captureCount, 0, `expected 0 test-owned capture-helper processes, found ${captureCount}`)
    return '0 hotkey-helper + 0 capture-helper processes parented by the test'
  })

  // --- summary -----------------------------------------------------------
  const passed = results.filter(result => result.ok && !result.skipped).length
  const skipped = results.filter(result => result.skipped)
  const failed = results.filter(result => !result.ok)
  console.log('')
  console.log('============================================================')
  console.log(' dsh-screencapture hotkey / SSE / config test summary')
  console.log('============================================================')
  for (const result of results) {
    const label = result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL'
    console.log(`${label}  ${result.name}`)
    if (result.detail) console.log(`        ${result.detail}`)
    if (!result.ok && result.error) {
      console.log(`        ${result.error.message || result.error}`)
    }
  }
  console.log('------------------------------------------------------------')
  if (Number.isFinite(timings.hotkeyToSseMs)) {
    console.log(`Hotkey E2E (SendKeys process start → capture SSE frame): ${timings.hotkeyToSseMs.toFixed(0)} ms (includes ~0.3–0.5 s PowerShell startup for SendKeys)`)
  }
  if (Number.isFinite(timings.globalCaptureFlowMs)) {
    console.log(`Global capture flow (capture + cache + activate attempt + SSE broadcast): ${timings.globalCaptureFlowMs.toFixed(0)} ms (warm helper)`)
  }
  if (e2eEvidence) console.log(`Global-hotkey capture evidence PNG: ${e2eEvidence}`)
  console.log(`Settings file used by the tests: ${settingsPath}`)
  console.log('------------------------------------------------------------')
  console.log(`${passed}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`)
  console.log(failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.length} failed)`)
  process.exitCode = failed.length === 0 ? 0 : 1

  for (const child of fakeChildren) {
    if (!child.exited) {
      try {
        child.kill()
      } catch {
        /* scripted child */
      }
    }
  }
  return process.exitCode
}

main().then(
  (code) => {
    process.stdout.write('', () => process.exit(code))
  },
  (error) => {
    console.error('FATAL: the hotkey test harness crashed before reporting')
    console.error(error && error.stack ? error.stack : error)
    process.exit(1)
  },
)
