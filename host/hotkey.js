/**
 * dsh-screencapture — OS-global hotkey manager.
 *
 * Owns `host/hotkey-helper.ps1`: one warm PowerShell process that registers a
 * single Win32 global hotkey (RegisterHotKey) on a hidden WinForms form and
 * prints one `hotkey` line per press. The manager converts the client's
 * `KeyboardEvent.code` chord into a virtual-key code + modifier mask, keeps one
 * registration alive, debounces presses (400 ms), restarts cleanly when the
 * chord changes, persists `{enabled, shortcut}` to
 * `<DSH_HOME>/dsh-screencapture/settings.json`, and never leaks the helper.
 *
 * A failed registration (for example a chord already taken by another app) is
 * swallowed into the status object — it must never fail plugin load — while an
 * invalid chord is reported as an `invalid-shortcut` error.
 *
 * @module dsh-screencapture/host/hotkey
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Win32 modifier masks accepted by RegisterHotKey. */
export const MODIFIER_MASK = Object.freeze({
  alt: 0x1,
  ctrl: 0x2,
  shift: 0x4,
  meta: 0x8,
})

/** Bounded wait for the helper's `ready`/`error` registration line. */
export const REGISTRATION_TIMEOUT_MS = 3000

/** Per-event debounce: ignores repeated presses closer than this. */
export const HOTKEY_DEBOUNCE_MS = 400

const HELPER_SCRIPT_PATH = fileURLToPath(new URL('./hotkey-helper.ps1', import.meta.url))
const HELPER_ARGUMENTS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File']
const DEFAULT_POWERSHELL_PATH = process.env.DSH_SCREENSHOT_POWERSHELL
  || 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Virtual-key codes for the KeyboardEvent.code values the recorder can produce. */
export const VK_BY_CODE = Object.freeze(buildVirtualKeyTable())

function buildVirtualKeyTable() {
  const table = {}
  for (let index = 0; index < 26; index += 1) {
    table[`Key${String.fromCharCode(65 + index)}`] = 65 + index
  }
  for (let index = 0; index < 10; index += 1) {
    table[`Digit${index}`] = 48 + index
    table[`Numpad${index}`] = 96 + index
  }
  for (let index = 0; index < 12; index += 1) {
    table[`F${index + 1}`] = 112 + index
  }
  Object.assign(table, {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    NumpadEnter: 13,
    Escape: 27,
    Space: 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
    CapsLock: 20,
    NumLock: 144,
    ScrollLock: 145,
    Semicolon: 186,
    Equal: 187,
    Comma: 188,
    Minus: 189,
    Period: 190,
    Slash: 191,
    Backquote: 192,
    BracketLeft: 219,
    Backslash: 220,
    BracketRight: 221,
    Quote: 222,
    NumpadMultiply: 106,
    NumpadAdd: 107,
    NumpadSubtract: 109,
    NumpadDecimal: 110,
    NumpadDivide: 111,
  })
  return table
}

/**
 * Create an Error carrying a stable machine-readable `code`.
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function hostError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize and validate a chord from the client's settings shape.
 *
 * A global hotkey without any modifier is rejected on purpose: registering a
 * bare key globally would swallow that key for every application.
 *
 * @param {unknown} shortcut `{code, ctrl, shift, alt, meta}`
 * @returns {{code: string, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean}}
 */
export function normalizeShortcut(shortcut) {
  if (!isPlainObject(shortcut)) throw hostError('invalid-shortcut', 'shortcut must be an object')
  const code = shortcut.code
  if (typeof code !== 'string' || code === '') {
    throw hostError('invalid-shortcut', 'shortcut.code must be a KeyboardEvent.code string')
  }
  if (VK_BY_CODE[code] === undefined) {
    throw hostError('invalid-shortcut', `shortcut.code "${code}" is not supported as a global shortcut`)
  }
  const normalized = {
    code,
    ctrl: Boolean(shortcut.ctrl),
    shift: Boolean(shortcut.shift),
    alt: Boolean(shortcut.alt),
    meta: Boolean(shortcut.meta),
  }
  if (modifierMask(normalized) === 0) {
    throw hostError(
      'invalid-shortcut',
      'a global shortcut needs at least one modifier key (Ctrl, Shift, Alt or Meta)',
    )
  }
  return normalized
}

/**
 * Convert a keyboard chord into Win32 `{vk, modifiers}`.
 * @param {unknown} shortcut `{code, ctrl, shift, alt, meta}`
 * @returns {{vk: number, modifiers: number}}
 */
export function chordToVirtualKey(shortcut) {
  const normalized = normalizeShortcut(shortcut)
  return { vk: VK_BY_CODE[normalized.code], modifiers: modifierMask(normalized) }
}

/**
 * Modifier bit mask for an already-normalized shortcut.
 * @param {{ctrl: boolean, shift: boolean, alt: boolean, meta: boolean}} shortcut
 * @returns {number}
 */
export function modifierMask(shortcut) {
  let mask = 0
  if (shortcut.alt) mask |= MODIFIER_MASK.alt
  if (shortcut.ctrl) mask |= MODIFIER_MASK.ctrl
  if (shortcut.shift) mask |= MODIFIER_MASK.shift
  if (shortcut.meta) mask |= MODIFIER_MASK.meta
  return mask
}

/** Whether two normalized shortcuts are equal field-by-field. */
export function shortcutsEqual(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right
  }
  return left.code === right.code
    && Boolean(left.ctrl) === Boolean(right.ctrl)
    && Boolean(left.shift) === Boolean(right.shift)
    && Boolean(left.alt) === Boolean(right.alt)
    && Boolean(left.meta) === Boolean(right.meta)
}

/**
 * The persistent settings path from the task contract:
 * `<DSH_HOME || ~/.dsh>/dsh-screencapture/settings.json`.
 * @returns {string}
 */
export function defaultSettingsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-screencapture', 'settings.json')
}

function emptyStatus() {
  return { enabled: false, registered: false, shortcut: null, error: null }
}

/**
 * Persistent, serialized owner of one global-hotkey helper process.
 */
class HotkeyManager {
  #spawnImpl
  #powershellPath
  #helperScriptPath
  #settingsPath
  #logger
  #platform

  #child = null
  #stdoutBuffer = ''
  #stderrTail = ''
  #state = emptyStatus()
  #onHotkey = null
  #readySettle = null
  #registrationTimer = null
  #lastEventAt = 0
  #closing = false
  #operation = Promise.resolve()
  #closePromise = null

  /**
   * @param {object} [options]
   * @param {string} [options.settingsPath] override for the persisted settings file
   * @param {string} [options.helperScriptPath] override for hotkey-helper.ps1
   * @param {string} [options.powershellPath] powershell.exe path
   * @param {Function} [options.spawn] child_process.spawn seam (tests)
   * @param {{warn?: Function, info?: Function}} [options.logger]
   * @param {string} [options.platform] `process.platform` override (tests / non-Windows guards)
   */
  constructor(options = {}) {
    this.#spawnImpl = options.spawn || nodeSpawn
    this.#powershellPath = options.powershellPath || DEFAULT_POWERSHELL_PATH
    this.#helperScriptPath = options.helperScriptPath || HELPER_SCRIPT_PATH
    this.#settingsPath = options.settingsPath || defaultSettingsPath()
    this.#logger = options.logger
    this.#platform = options.platform || process.platform
  }

  /** Absolute path of the persisted settings file. */
  get settingsPath() {
    return this.#settingsPath
  }

  /** Whether a live hotkey helper process is currently owned by this manager. */
  get hasProcess() {
    return this.#child !== null
  }

  /** OS process id of the hotkey helper, or undefined when none is running. */
  get pid() {
    return this.#child && typeof this.#child.pid === 'number' ? this.#child.pid : undefined
  }

  /** Callback invoked (debounced) for each OS-global hotkey press. */
  get onHotkey() {
    return this.#onHotkey
  }

  set onHotkey(callback) {
    this.#onHotkey = typeof callback === 'function' ? callback : null
  }

  /**
   * Current client-facing status.
   * @returns {{enabled: boolean, registered: boolean, shortcut: object|null, error: string|null}}
   */
  status() {
    return {
      enabled: this.#state.enabled,
      registered: this.#state.registered,
      shortcut: this.#state.shortcut ? { ...this.#state.shortcut } : null,
      error: this.#state.error,
    }
  }

  /**
   * Apply a full configuration: start/stop/restart the registration and persist
   * the validated setting. A registration failure (chord taken, helper missing)
   * is reported in the returned status, not thrown.
   * @param {{enabled: boolean, shortcut: object|null}} config
   */
  configure(config) {
    return this.#enqueue(() => this.#configure(config))
  }

  /** Convenience: enable with `shortcut`. */
  start(shortcut) {
    return this.configure({ enabled: true, shortcut })
  }

  /** Convenience: disable and kill the helper. */
  stop() {
    return this.configure({ enabled: false, shortcut: null })
  }

  /**
   * Load `<DSH_HOME>/dsh-screencapture/settings.json` and apply it. Missing or
   * corrupt files mean "disabled"; a taken chord or an invalid persisted chord
   * becomes `status.error` instead of throwing.
   * @returns {Promise<object>} status
   */
  loadStoredConfig() {
    return this.#enqueue(async () => {
      let stored = null
      try {
        stored = await this.#readSettings()
        if (stored !== null && stored.enabled && stored.shortcut === null) {
          throw hostError('invalid-shortcut', 'the stored global hotkey has no shortcut')
        }
      } catch (error) {
        this.#log('warn', `dsh-screencapture: could not read the global hotkey settings: ${errorMessage(error)}`)
        stored = null
      }
      if (stored === null) {
        await this.#stopChild()
        this.#state = emptyStatus()
        return this.status()
      }
      try {
        return await this.#applyConfig(stored)
      } catch (error) {
        this.#state = {
          enabled: Boolean(stored.enabled),
          registered: false,
          shortcut: stored.shortcut || null,
          error: error.code === 'invalid-shortcut' ? 'invalid-shortcut' : errorMessage(error),
        }
        this.#log('warn', `dsh-screencapture: stored global hotkey is not usable: ${errorMessage(error)}`)
        return this.status()
      }
    })
  }

  /** Kill the helper and disable the manager. Idempotent; cannot be reused. */
  async close() {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    await this.#stopChild()
    this.#state = emptyStatus()
    this.#closePromise = Promise.resolve()
    return this.#closePromise
  }

  // --- configuration -----------------------------------------------------

  #enqueue(task) {
    const next = this.#operation.then(task, task)
    this.#operation = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async #configure(config) {
    if (this.#closing) throw hostError('engine-closed', 'the global hotkey manager is closed')
    if (!isPlainObject(config) || typeof config.enabled !== 'boolean') {
      throw hostError('invalid-config', 'config.enabled must be a boolean')
    }
    const shortcut = config.shortcut === undefined || config.shortcut === null
      ? null
      : normalizeShortcut(config.shortcut)
    if (config.enabled && shortcut === null) {
      throw hostError('invalid-shortcut', 'enabling the global hotkey requires a shortcut')
    }
    return this.#applyConfig({ enabled: config.enabled, shortcut })
  }

  /**
   * Stop the current registration, start a new one when enabled, persist.
   * Never throws for a registration failure.
   * @param {{enabled: boolean, shortcut: object|null}} config
   */
  async #applyConfig(config) {
    await this.#stopChild()
    this.#lastEventAt = 0
    this.#state = {
      enabled: config.enabled,
      registered: false,
      shortcut: config.shortcut ? { ...config.shortcut } : null,
      error: null,
    }
    if (config.enabled && config.shortcut) {
      await this.#startChild(config.shortcut)
    }
    await this.#persist()
    return this.status()
  }

  async #startChild(shortcut) {
    if (this.#platform !== 'win32') {
      // Windows-only capability in v1: still validate the chord (so the route
      // can answer consistently) but never try to spawn PowerShell elsewhere.
      chordToVirtualKey(shortcut)
      this.#state.registered = false
      this.#state.error = 'unsupported-platform'
      this.#log('warn', 'dsh-screencapture: the OS-global hotkey is only implemented on Windows')
      return
    }
    const { vk, modifiers } = chordToVirtualKey(shortcut)
    await new Promise((resolve) => {
      let settled = false
      const settle = (error) => {
        if (settled) return
        settled = true
        if (this.#registrationTimer) {
          clearTimeout(this.#registrationTimer)
          this.#registrationTimer = null
        }
        this.#readySettle = null
        if (error) {
          this.#state.registered = false
          this.#state.error = error
          this.#killChild()
          this.#log('warn', `dsh-screencapture: global hotkey ${shortcut.code} was not registered: ${error}`)
        } else {
          this.#state.registered = true
          this.#state.error = null
        }
        resolve()
      }
      this.#readySettle = settle
      let child
      try {
        child = this.#spawnImpl(
          this.#powershellPath,
          [...HELPER_ARGUMENTS, this.#helperScriptPath, String(vk), String(modifiers)],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env },
        )
      } catch (error) {
        settle(`could not start the global hotkey helper: ${errorMessage(error)}`)
        return
      }
      this.#child = child
      this.#stdoutBuffer = ''
      this.#stderrTail = ''
      this.#attachChild(child)
      this.#registrationTimer = setTimeout(() => {
        this.#registrationTimer = null
        settle(`the global hotkey helper did not register the shortcut within ${REGISTRATION_TIMEOUT_MS} ms`)
      }, REGISTRATION_TIMEOUT_MS)
      if (this.#registrationTimer && typeof this.#registrationTimer.unref === 'function') {
        this.#registrationTimer.unref()
      }
    })
  }

  // --- helper process lifecycle -----------------------------------------

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
        this.#stderrTail = (this.#stderrTail + String(chunk)).slice(-4096)
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
  }

  /** @param {string} line */
  #onResponseLine(line) {
    if (line.startsWith('ready|')) {
      if (this.#readySettle) this.#readySettle(null)
      return
    }
    if (line.startsWith('error|')) {
      const code = Number(line.slice('error|'.length))
      const message = code === 1409
        ? 'the shortcut is already registered by another application'
        : `RegisterHotKey failed (Win32 error ${Number.isFinite(code) ? code : 'unknown'})`
      if (this.#readySettle) this.#readySettle(message)
      else this.#log('warn', `dsh-screencapture: global hotkey helper reported: ${message}`)
      return
    }
    if (line === 'hotkey') {
      this.#handleHotkeyEvent()
      return
    }
    if (line.startsWith('OK|') || line.startsWith('ERR|')) return // command acknowledgements
    this.#log('warn', `dsh-screencapture: unexpected global hotkey helper output: ${line.slice(0, 200)}`)
  }

  /** @param {import('node:child_process').ChildProcess} child */
  #onChildError(child, error) {
    if (child !== this.#child) return
    this.#child = null
    this.#stdoutBuffer = ''
    this.#state.registered = false
    const message = `the global hotkey helper failed: ${errorMessage(error)}`
    this.#state.error = message
    this.#log('warn', `dsh-screencapture: ${message}`)
    if (this.#readySettle) this.#readySettle(message)
  }

  /** @param {import('node:child_process').ChildProcess} child */
  #onChildExit(child, code, signal) {
    if (child !== this.#child) return
    this.#child = null
    this.#stdoutBuffer = ''
    this.#state.registered = false
    const detail = code === null || code === undefined ? `signal ${signal}` : `exit code ${code}`
    const stderrTail = this.#stderrTail.trim()
    const message = `the global hotkey helper exited (${detail})${stderrTail ? `: ${stderrTail}` : ''}`
    if (this.#readySettle) {
      this.#state.error = `the global hotkey helper exited before registering (${detail})`
      this.#readySettle(this.#state.error)
      return
    }
    this.#state.error = message
    this.#log('warn', `dsh-screencapture: ${message}`)
  }

  /** @param {string} shortcut */
  #killChild() {
    const child = this.#child
    this.#child = null
    this.#stdoutBuffer = ''
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

  #stopChild() {
    if (this.#readySettle) {
      const settle = this.#readySettle
      this.#readySettle = null
      settle('the global hotkey registration was superseded')
    }
    if (this.#registrationTimer) {
      clearTimeout(this.#registrationTimer)
      this.#registrationTimer = null
    }
    this.#killChild()
    this.#state.registered = false
  }

  // --- events ------------------------------------------------------------

  #handleHotkeyEvent() {
    const now = Date.now()
    if (now - this.#lastEventAt < HOTKEY_DEBOUNCE_MS) return
    this.#lastEventAt = now
    const callback = this.#onHotkey
    if (typeof callback !== 'function') return
    try {
      const result = callback()
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          this.#log('warn', `dsh-screencapture: global hotkey handler failed: ${errorMessage(error)}`)
        })
      }
    } catch (error) {
      this.#log('warn', `dsh-screencapture: global hotkey handler failed: ${errorMessage(error)}`)
    }
  }

  // --- persistence -------------------------------------------------------

  /** @returns {Promise<{enabled: boolean, shortcut: object|null}|null>} */
  async #readSettings() {
    let text
    try {
      text = await readFile(this.#settingsPath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) return null
    const enabled = parsed.enabled === true
    let shortcut = null
    if (parsed.shortcut !== undefined && parsed.shortcut !== null) {
      shortcut = normalizeShortcut(parsed.shortcut)
    }
    return { enabled, shortcut }
  }

  /** Persist the validated `{enabled, shortcut}` (atomic via temp + rename). */
  async #persist() {
    const payload = JSON.stringify({
      enabled: this.#state.enabled,
      shortcut: this.#state.shortcut,
    }, null, 2) + '\n'
    try {
      await mkdir(dirname(this.#settingsPath), { recursive: true })
      const temporaryPath = `${this.#settingsPath}.${process.pid}.tmp`
      await writeFile(temporaryPath, payload)
      await rename(temporaryPath, this.#settingsPath)
    } catch (error) {
      this.#log('warn', `dsh-screencapture: could not persist the global hotkey settings: ${errorMessage(error)}`)
    }
  }

  #log(level, message) {
    const logger = this.#logger
    if (!logger) return
    try {
      const write = logger[level] || logger.info || logger.log
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      /* logging must never break hotkey handling */
    }
  }
}

/**
 * Create the global hotkey manager.
 * @param {ConstructorParameters<typeof HotkeyManager>[0]} [options]
 * @returns {HotkeyManager}
 */
export function createHotkeyManager(options = {}) {
  return new HotkeyManager(options)
}
