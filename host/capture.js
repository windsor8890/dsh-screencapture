/**
 * dsh-screencapture — persistent PowerShell helper process manager.
 *
 * The DSH Host process runs as Electron in `ELECTRON_RUN_AS_NODE=1` mode: full
 * Node APIs, no Electron APIs, and therefore no way to capture the screen or
 * write the Windows clipboard directly. `host/capture-helper.ps1` is spawned
 * once, kept warm, and driven over stdin/stdout with one command per line.
 *
 * Contract obligations implemented here:
 * - one helper process, started lazily; `status` never spawns it;
 * - commands are serialized (one in flight, the rest queued);
 * - a per-command 5 s timeout;
 * - on a helper crash or timeout the helper is restarted and the command is
 *   retried exactly once, then the command fails;
 * - the helper (and the temp directory) is killed/removed on `close()`;
 * - `capture()` returns `{dataUrl, width, height, screens, virtual, windows,
 *   capturedAt}` — image and the Z-ordered top-level window list of the same
 *   moment, for window snapping in the overlay;
 * - `setClipboardPng(buffer)` writes a temp PNG and asks the helper to put it
 *   on the clipboard, deleting the temp file after the acknowledgement;
 * - `prepareOverlayWindow(pid)` / `restoreOverlayWindow()` temporarily maximize
 *   the DSH window for the overlay and put its exact placement back, with a
 *   best-effort restore in `close()` so an unload cannot leave it maximized.
 *
 * @module dsh-screencapture/host/capture
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Per-command timeout from the contract. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5000

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HELPER_SCRIPT_PATH = fileURLToPath(new URL('./capture-helper.ps1', import.meta.url))
const HELPER_ARGUMENTS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File']
const DEFAULT_POWERSHELL_PATH = process.env.DSH_SCREENSHOT_POWERSHELL
  || 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const MAX_STDOUT_BUFFER_BYTES = 64 * 1024
const MAX_STDERR_TAIL_BYTES = 4096

/**
 * Create an Error carrying a stable machine-readable `code`, which the route
 * layer turns into `{ok:false, code, message}`.
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
export function hostError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** @param {unknown} error */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function numberOrZero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isPngBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= PNG_SIGNATURE.length
    && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

/**
 * Normalize one `OK|screens|<json>` payload into the route-facing monitor
 * table. PowerShell's ConvertTo-Json can collapse a one-element list to an
 * object, so both shapes are accepted.
 * @param {string} payload
 */
function parseScreensPayload(payload) {
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw hostError('capture-failed', 'the capture helper returned malformed monitor information')
  }
  const rawScreens = Array.isArray(parsed && parsed.screens)
    ? parsed.screens
    : (parsed && parsed.screens ? [parsed.screens] : [])
  const screens = rawScreens.map(entry => ({
    x: numberOrZero(entry && entry.x),
    y: numberOrZero(entry && entry.y),
    width: numberOrZero(entry && entry.width),
    height: numberOrZero(entry && entry.height),
    primary: Boolean(entry && entry.primary),
  }))
  const virtual = (parsed && parsed.virtual) || {}
  return {
    screens,
    virtual: {
      x: numberOrZero(virtual.x),
      y: numberOrZero(virtual.y),
      width: numberOrZero(virtual.width),
      height: numberOrZero(virtual.height),
    },
  }
}

/**
 * Parse one `OK|windows|<json>` payload into the route-facing window list
 * (Z-order preserved: topmost first). Entries that cannot be represented are
 * dropped rather than failing the capture.
 * @param {string} payload
 * @returns {Array<{hwnd: number, title: string, className: string, pid: number, processName: string, x: number, y: number, width: number, height: number}>}
 */
function parseWindowListPayload(payload) {
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw hostError('windows-failed', 'the capture helper returned malformed window information')
  }
  if (!Array.isArray(parsed)) {
    throw hostError('windows-failed', 'the capture helper returned a non-array window list')
  }
  const windows = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const window = {
      hwnd: Number(entry.hwnd),
      title: typeof entry.title === 'string' ? entry.title : '',
      className: typeof entry.className === 'string' ? entry.className : '',
      pid: Number(entry.pid),
      processName: typeof entry.processName === 'string' ? entry.processName : '',
      x: Number(entry.x),
      y: Number(entry.y),
      width: Number(entry.width),
      height: Number(entry.height),
    }
    if (!Number.isFinite(window.hwnd) || window.hwnd <= 0) continue
    if (!Number.isFinite(window.pid) || window.pid < 0) continue
    if (!Number.isFinite(window.x) || !Number.isFinite(window.y)) continue
    if (!Number.isFinite(window.width) || !Number.isFinite(window.height)) continue
    if (window.width <= 1 || window.height <= 1) continue
    if (window.title === '') continue
    windows.push(window)
  }
  return windows
}

/**
 * Persistent, serialized owner of one PowerShell capture helper.
 *
 * State values reported to `status` are `idle`, `starting`, `ready`, `failed`.
 */
class CaptureEngine {
  #spawnImpl
  #powershellPath
  #helperScriptPath
  #commandTimeoutMs
  #logger
  #tempRoot

  #child = null
  #childExited = false
  #state = 'idle'
  #queue = []
  #inFlight = null
  #stdoutBuffer = ''
  #stderrTail = ''
  #lastSpawnError = ''
  #screens = null
  #closing = false
  #closePromise = null
  #tempDir = null
  #tempDirPromise = null
  #fileCounter = 0
  #overlaySnapshot = null

  /**
   * @param {object} [options]
   * @param {number} [options.commandTimeoutMs] per-command timeout (default 5000)
   * @param {string} [options.powershellPath] powershell.exe path
   * @param {string} [options.helperScriptPath] capture-helper.ps1 path
   * @param {Function} [options.spawn] child_process.spawn seam (tests)
   * @param {{warn?: Function, info?: Function}} [options.logger]
   * @param {string} [options.tempRoot] parent for the temp directory
   */
  constructor(options = {}) {
    this.#spawnImpl = options.spawn || nodeSpawn
    this.#powershellPath = options.powershellPath || DEFAULT_POWERSHELL_PATH
    this.#helperScriptPath = options.helperScriptPath || HELPER_SCRIPT_PATH
    this.#commandTimeoutMs = options.commandTimeoutMs === undefined
      ? DEFAULT_COMMAND_TIMEOUT_MS
      : options.commandTimeoutMs
    this.#logger = options.logger
    this.#tempRoot = options.tempRoot || tmpdir()
  }

  /** Helper lifecycle state: idle | starting | ready | failed. */
  get state() {
    return this.#state
  }

  /** Whether a live helper process is currently owned by this engine. */
  get hasProcess() {
    return this.#child !== null && !this.#childExited
  }

  /** The per-engine temp directory once created (undefined before first use). */
  get tempDirectory() {
    return this.#tempDir || undefined
  }

  /**
   * Route-facing status snapshot. Does not spawn the helper; monitor geometry
   * is empty until the first capture (or helper query).
   */
  status() {
    return { helper: this.#state, ...this.screensSnapshot() }
  }

  /** Last known monitor table (empty before the first helper query). */
  screensSnapshot() {
    const cached = this.#screens
    if (!cached) return { screens: [], virtual: { x: 0, y: 0, width: 0, height: 0 } }
    return {
      screens: cached.screens.map(screen => ({ ...screen })),
      virtual: { ...cached.virtual },
    }
  }

  /** Warm the helper and round-trip a ping. */
  async ping() {
    await this.#run('ping', 'ping')
  }

  /**
   * Capture the whole virtual desktop at physical pixels, plus the top-level
   * window list of the same moment (window snapping data).
   *
   * The screenshot is taken first and the window enumeration runs immediately
   * after it, before any activation/maximization, so the list matches the
   * frozen image. Enumeration failure degrades to `windows: []` and never fails
   * the capture.
   *
   * @returns {Promise<{dataUrl: string, width: number, height: number, screens: object[], virtual: {x:number,y:number,width:number,height:number}, windows: object[], capturedAt: string}>}
   */
  async capture() {
    try {
      const monitors = await this.#readScreens()
      const directory = await this.#ensureTempDirectory()
      const fileName = `capture-${process.pid}-${++this.#fileCounter}.png`
      const pngPath = join(directory, fileName)
      try {
        const payload = await this.#run(`capture|${pngPath}`, 'capture')
        const fields = String(payload).split('|')
        const width = Number(fields[0])
        const height = Number(fields[1])
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
          throw hostError('capture-failed', 'the capture helper returned invalid image dimensions')
        }
        // State at capture time: enumerate windows right after the screenshot,
        // before anything activates or maximizes a window.
        const windows = await this.#readWindowList()
        const capturedAt = new Date().toISOString()
        const buffer = await readFile(pngPath)
        if (!isPngBuffer(buffer)) {
          throw hostError('capture-failed', 'the capture helper did not produce a valid PNG')
        }
        return {
          dataUrl: PNG_DATA_URL_PREFIX + buffer.toString('base64'),
          width,
          height,
          screens: monitors.screens.map(screen => ({ ...screen })),
          virtual: { ...monitors.virtual },
          windows,
          capturedAt,
        }
      } finally {
        await rm(pngPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      if (error && error.code === 'capture-failed') throw error
      throw hostError('capture-failed', errorMessage(error))
    }
  }

  /**
   * Put a PNG buffer on the Windows clipboard as an image.
   * @param {Buffer} pngBuffer
   */
  async setClipboardPng(pngBuffer) {
    if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
      throw hostError('clipboard-failed', 'the clipboard image payload is empty')
    }
    try {
      const directory = await this.#ensureTempDirectory()
      const fileName = `clipboard-${process.pid}-${++this.#fileCounter}.png`
      const pngPath = join(directory, fileName)
      try {
        await writeFile(pngPath, pngBuffer)
        await this.#run(`clipboard|${pngPath}`, 'clipboard')
      } finally {
        await rm(pngPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      if (error && error.code === 'clipboard-failed') throw error
      throw hostError('clipboard-failed', errorMessage(error))
    }
  }

  /**
   * Bring a process's top-level window to the foreground. Used by the global
   * hotkey flow to surface the DSH window after a background capture.
   * @param {number} processId target process id (the Electron main process)
   * @returns {Promise<string>} the activated HWND as a decimal string
   */
  async activate(processId) {
    const targetPid = Number(processId)
    if (!Number.isInteger(targetPid) || targetPid <= 0) {
      throw hostError('activate-failed', `invalid process id: ${String(processId)}`)
    }
    try {
      const payload = await this.#run(`activate|${targetPid}`, 'activate')
      const handle = String(payload).trim()
      if (handle === '' || handle === '0') {
        throw hostError('activate-failed', `no top-level window was found for process ${targetPid}`)
      }
      return handle
    } catch (error) {
      if (error && error.code === 'activate-failed') throw error
      throw hostError('activate-failed', errorMessage(error))
    }
  }

  /**
   * Temporarily maximize a process's top-level window for the capture overlay
   * and remember its exact normal placement for a later restore.
   *
   * The single pending snapshot is replaced; if one is already pending it is
   * restored first (so a double prepare can never lose the original placement).
   *
   * @param {number} processId target process id (the Electron main process)
   * @returns {Promise<{ok: boolean, changed: boolean, hwnd: string, placement: {showCmd: number, left: number, top: number, right: number, bottom: number}}>}
   */
  async prepareOverlayWindow(processId) {
    const targetPid = Number(processId)
    if (!Number.isInteger(targetPid) || targetPid <= 0) {
      throw hostError('overlay-prepare-failed', `invalid process id: ${String(processId)}`)
    }
    if (process.platform !== 'win32') {
      throw hostError('overlay-prepare-failed', 'unsupported-platform')
    }
    if (this.#overlaySnapshot) {
      try {
        await this.restoreOverlayWindow()
      } catch {
        this.#overlaySnapshot = null
      }
    }
    try {
      const payload = await this.#run(`prepare-overlay|${targetPid}`, 'prepare-overlay')
      const fields = String(payload).split('|')
      if (fields.length < 7) {
        throw hostError('overlay-prepare-failed', `malformed prepare-overlay response: ${String(payload).slice(0, 120)}`)
      }
      const hwnd = fields[0].trim()
      const changed = fields[1].trim() === '1'
      const showCmd = Number(fields[2])
      const placement = {
        showCmd,
        left: Number(fields[3]),
        top: Number(fields[4]),
        right: Number(fields[5]),
        bottom: Number(fields[6]),
      }
      if (!/^\d+$/.test(hwnd) || Number(hwnd) <= 0) {
        throw hostError('overlay-prepare-failed', 'the capture helper returned an invalid window handle')
      }
      if (!Number.isInteger(showCmd)) {
        throw hostError('overlay-prepare-failed', 'the capture helper returned an invalid window placement')
      }
      for (const key of ['left', 'top', 'right', 'bottom']) {
        if (!Number.isFinite(placement[key])) {
          throw hostError('overlay-prepare-failed', `the capture helper returned an invalid ${key} coordinate`)
        }
      }
      this.#overlaySnapshot = { hwnd, ...placement }
      return { ok: true, changed, hwnd, placement }
    } catch (error) {
      if (error && error.code === 'overlay-prepare-failed') throw error
      throw hostError('overlay-prepare-failed', errorMessage(error))
    }
  }

  /**
   * Put the DSH window back to the placement remembered by
   * `prepareOverlayWindow()`. A window that was originally maximized is left
   * untouched. Never changes the foreground.
   *
   * Idempotent: `{ok:true, restored:false}` when no snapshot is pending.
   * @returns {Promise<{ok: boolean, restored: boolean}>}
   */
  async restoreOverlayWindow() {
    const snapshot = this.#overlaySnapshot
    if (!snapshot) return { ok: true, restored: false }
    // Clear first: restore is a one-shot, idempotent operation.
    this.#overlaySnapshot = null
    try {
      await this.#run(
        `restore-overlay|${snapshot.hwnd}|${snapshot.showCmd}|${snapshot.left}|${snapshot.top}|${snapshot.right}|${snapshot.bottom}`,
        'restore-overlay',
      )
      return { ok: true, restored: true }
    } catch (error) {
      if (error && error.code === 'overlay-restore-failed') throw error
      throw hostError('overlay-restore-failed', errorMessage(error))
    }
  }

  /**
   * Kill the helper, reject pending commands, and remove the temp directory.
   * If an overlay snapshot is still pending, a best-effort restore happens
   * first so a plugin unload can never leave the DSH window maximized.
   * Idempotent; the engine cannot be reused afterwards.
   */
  close() {
    if (this.#closePromise) return this.#closePromise
    this.#closePromise = (async () => {
      if (this.#overlaySnapshot) {
        try {
          await this.restoreOverlayWindow()
        } catch {
          this.#overlaySnapshot = null
        }
      }
      this.#closing = true
      this.#state = 'idle'
      const closedError = hostError('engine-closed', 'the capture engine was closed')
      const pending = this.#inFlight ? [this.#inFlight, ...this.#queue] : [...this.#queue]
      this.#inFlight = null
      this.#queue = []
      for (const item of pending) {
        if (item.timer) {
          clearTimeout(item.timer)
          item.timer = null
        }
        try {
          item.reject(closedError)
        } catch {
          /* the caller is gone; nothing to do */
        }
      }
      this.#killChild()
      this.#screens = null
      this.#stdoutBuffer = ''
      await this.#removeTempDirectory()
    })()
    return this.#closePromise
  }

  // --- helper process lifecycle -------------------------------------------

  /**
   * Ensure a helper process exists.
   * @returns {boolean} whether a live helper is available.
   */
  #ensureChild() {
    if (this.#closing) return false
    if (this.#child && !this.#childExited) return true
    this.#state = 'starting'
    let child
    try {
      child = this.#spawnImpl(
        this.#powershellPath,
        [...HELPER_ARGUMENTS, this.#helperScriptPath],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env },
      )
    } catch (error) {
      this.#lastSpawnError = errorMessage(error)
      this.#state = 'failed'
      this.#log('warn', `dsh-screencapture: could not start the capture helper: ${this.#lastSpawnError}`)
      return false
    }
    this.#child = child
    this.#childExited = false
    this.#stdoutBuffer = ''
    this.#stderrTail = ''
    this.#attachChild(child)
    return true
  }

  /** @param {import('node:child_process').ChildProcess} child */
  #attachChild(child) {
    if (child.stdout) {
      if (typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => this.#onStdout(child, chunk))
      child.stdout.on('error', () => {})
    }
    if (child.stderr) {
      if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        this.#stderrTail = (this.#stderrTail + String(chunk)).slice(-MAX_STDERR_TAIL_BYTES)
      })
      child.stderr.on('error', () => {})
    }
    if (child.stdin) child.stdin.on('error', () => {})
    child.on('error', error => this.#onChildError(child, error))
    child.on('exit', (code, signal) => this.#onChildExit(child, code, signal))
  }

  /** @param {import('node:child_process').ChildProcess} child */
  #onStdout(child, chunk) {
    if (child !== this.#child) return
    this.#stdoutBuffer += String(chunk)
    let newlineAt
    while ((newlineAt = this.#stdoutBuffer.indexOf('\n')) >= 0) {
      const rawLine = this.#stdoutBuffer.slice(0, newlineAt)
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineAt + 1)
      const line = rawLine.replace(/\r$/, '')
      if (line === '') continue
      this.#onResponseLine(line)
    }
    if (this.#stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
      // Garbage on stdout means the protocol is broken: treat it as a crash so
      // the restart-once path gets a fresh process.
      this.#stdoutBuffer = ''
      const item = this.#inFlight
      if (item) {
        this.#failTransport(item, hostError('helper-protocol', 'the capture helper wrote unexpected output'))
      } else {
        this.#killChild()
      }
    }
  }

  /** @param {string} line */
  #onResponseLine(line) {
    const item = this.#inFlight
    if (!item) return // stray output from a process we no longer await
    const fields = line.split('|')
    const status = fields[0]
    const command = fields[1]
    if (status === 'OK' && command === item.command) {
      this.#completeCommand(item, fields.slice(2).join('|'))
      return
    }
    if (status === 'ERR' && command === item.command) {
      const message = fields.slice(2).join('|') || 'the capture helper reported an unknown error'
      this.#rejectCommand(item, hostError(`${item.command}-failed`, message))
      return
    }
    this.#failTransport(item, hostError('helper-protocol', `unexpected capture helper response: ${line.slice(0, 200)}`))
  }

  /** @param {import('node:child_process').ChildProcess} child */
  #onChildError(child, error) {
    if (child !== this.#child) return
    this.#child = null
    this.#childExited = true
    this.#lastSpawnError = errorMessage(error)
    this.#state = 'failed'
    this.#log('warn', `dsh-screencapture: capture helper error: ${this.#lastSpawnError}`)
    const item = this.#inFlight
    if (item) {
      this.#inFlight = null
      this.#failTransport(item, hostError('helper-spawn-failed', `the capture helper failed: ${this.#lastSpawnError}`))
    }
  }

  /** @param {import('node:child_process').ChildProcess} child */
  #onChildExit(child, code, signal) {
    if (child !== this.#child) return
    this.#child = null
    this.#childExited = true
    this.#stdoutBuffer = ''
    this.#screens = null
    this.#state = 'failed'
    const detail = code === null || code === undefined ? `signal ${signal}` : `exit code ${code}`
    const stderrTail = this.#stderrTail.trim()
    this.#log('warn', `dsh-screencapture: capture helper exited unexpectedly (${detail})${stderrTail ? `: ${stderrTail}` : ''}`)
    const item = this.#inFlight
    if (item) {
      this.#inFlight = null
      this.#failTransport(item, hostError(
        'helper-exited',
        `the capture helper exited unexpectedly (${detail})${stderrTail ? `: ${stderrTail}` : ''}`,
      ))
    }
  }

  /** Kill the current helper without touching queue bookkeeping. */
  #killChild() {
    const child = this.#child
    this.#child = null
    this.#childExited = true
    if (!child) return
    try {
      if (child.stdin && typeof child.stdin.end === 'function') child.stdin.end()
    } catch {
      /* already gone */
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  // --- command queue ------------------------------------------------------

  /**
   * Enqueue one helper command and resolve with its OK payload.
   * @param {string} line
   * @param {string} command
   * @returns {Promise<string>}
   */
  #run(line, command) {
    if (this.#closing) {
      return Promise.reject(hostError('engine-closed', 'the capture engine is closed'))
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ line, command, attemptsLeft: 2, resolve, reject, timer: null })
      this.#pump()
    })
  }

  /** Start the next queued command, spawning a helper if needed. */
  #pump() {
    if (this.#closing || this.#inFlight) return
    const item = this.#queue.shift()
    if (!item) return
    this.#inFlight = item
    if (!this.#ensureChild()) {
      this.#inFlight = null
      this.#failTransport(item, hostError('helper-spawn-failed', `could not start the capture helper: ${this.#lastSpawnError}`))
      return
    }
    const child = this.#child
    item.timer = setTimeout(() => {
      item.timer = null
      if (this.#inFlight !== item) return
      this.#failTransport(item, hostError(
        'helper-timeout',
        `the capture helper did not answer "${item.command}" within ${this.#commandTimeoutMs} ms`,
      ))
    }, this.#commandTimeoutMs)
    if (item.timer && typeof item.timer.unref === 'function') item.timer.unref()
    try {
      child.stdin.write(item.line + '\n', (error) => {
        if (!error) return
        if (this.#inFlight !== item) return
        this.#failTransport(item, hostError('helper-stdin', `could not write to the capture helper: ${errorMessage(error)}`))
      })
    } catch (error) {
      this.#failTransport(item, hostError('helper-stdin', `could not write to the capture helper: ${errorMessage(error)}`))
    }
  }

  /** One command answered successfully. */
  #completeCommand(item, payload) {
    if (this.#inFlight === item) this.#inFlight = null
    if (item.timer) {
      clearTimeout(item.timer)
      item.timer = null
    }
    this.#state = 'ready'
    item.resolve(payload)
    this.#pump()
  }

  /** One command answered with a helper-level error (the helper is healthy). */
  #rejectCommand(item, error) {
    if (this.#inFlight === item) this.#inFlight = null
    if (item.timer) {
      clearTimeout(item.timer)
      item.timer = null
    }
    this.#state = 'ready'
    item.reject(error)
    this.#pump()
  }

  /**
   * Transport-level failure (timeout / crash / spawn / protocol): drop the
   * helper and retry the command once, then fail it.
   */
  #failTransport(item, error) {
    if (this.#inFlight === item) this.#inFlight = null
    if (item.timer) {
      clearTimeout(item.timer)
      item.timer = null
    }
    this.#screens = null
    this.#log('warn', `dsh-screencapture: ${errorMessage(error)}`)
    this.#killChild()
    if (item.attemptsLeft > 1) {
      item.attemptsLeft -= 1
      this.#queue.unshift(item)
      this.#state = 'starting'
      this.#pump()
      return
    }
    this.#state = 'failed'
    item.reject(error)
    this.#pump()
  }

  // --- screens / window list / temp directory ----------------------------

  /** Query (once per helper process) the physical monitor table. */
  async #readScreens() {
    if (this.#screens) return this.#screens
    try {
      const payload = await this.#run('screens', 'screens')
      this.#screens = parseScreensPayload(payload)
      return this.#screens
    } catch (error) {
      throw hostError('capture-failed', `could not read the monitor layout: ${errorMessage(error)}`)
    }
  }

  /**
   * Query the captured-time top-level window list (window snapping data).
   * Enumeration failure degrades to an empty array: it must never fail a
   * capture that already succeeded.
   * @returns {Promise<object[]>}
   */
  async #readWindowList() {
    try {
      const payload = await this.#run('windows', 'windows')
      return parseWindowListPayload(payload)
    } catch (error) {
      this.#log('warn', `dsh-screencapture: could not enumerate top-level windows: ${errorMessage(error)}`)
      return []
    }
  }

  /** @returns {Promise<string>} */
  async #ensureTempDirectory() {
    if (this.#closing) throw hostError('engine-closed', 'the capture engine is closed')
    if (this.#tempDir) return this.#tempDir
    if (!this.#tempDirPromise) {
      this.#tempDirPromise = mkdtemp(join(this.#tempRoot, 'dsh-screencapture-')).then(
        async (directory) => {
          // close() may land between the check above and mkdtemp resolving; do
          // not leak the freshly created directory in that case.
          if (this.#closing) {
            await rm(directory, { recursive: true, force: true }).catch(() => {})
            throw hostError('engine-closed', 'the capture engine was closed')
          }
          this.#tempDir = directory
          return directory
        },
        (error) => {
          this.#tempDirPromise = null
          throw hostError('temp-directory-failed', `could not create the capture temp directory: ${errorMessage(error)}`)
        },
      )
    }
    return this.#tempDirPromise
  }

  /** Remove the engine temp directory (best effort); called from close(). */
  async #removeTempDirectory() {
    const pending = this.#tempDirPromise
    if (!pending) return
    const directory = await pending.catch(() => undefined)
    if (!directory) return
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    this.#tempDir = null
    this.#tempDirPromise = null
  }

  #log(level, message) {
    const logger = this.#logger
    if (!logger) return
    try {
      const write = logger[level] || logger.info || logger.log
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      /* logging must never break capture */
    }
  }
}

/**
 * Create the capture engine.
 * @param {ConstructorParameters<typeof CaptureEngine>[0]} [options]
 * @returns {CaptureEngine}
 */
export function createCaptureEngine(options = {}) {
  return new CaptureEngine(options)
}
