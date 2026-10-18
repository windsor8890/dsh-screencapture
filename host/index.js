/**
 * dsh-screencapture — host half (Cordis plugin).
 *
 * Mounts the native screenshot capability of the DSH Web GUI: whole-desktop
 * capture at physical pixels, clipboard copy, PNG save/reveal, and the
 * Phase-B OS-global hotkey pipeline (global capture → SSE event → cached
 * "last capture" → foreground the DSH window), all behind exact routes under
 * `/api/dsh-screencapture/*` on the host web server.
 *
 * Why a host half exists: the Electron shell denies renderer display capture
 * (`browserSession.setDisplayMediaRequestHandler((_request, cb) => cb({}))`),
 * and the Host process runs in `ELECTRON_RUN_AS_NODE=1` Node mode where no
 * Electron API is available. The Host therefore owns two warm PowerShell
 * helpers: `host/capture-helper.ps1` (System.Drawing capture, STA clipboard,
 * window activation) and `host/hotkey-helper.ps1` (RegisterHotKey global
 * hotkey), driven by `host/capture.js` and `host/hotkey.js`.
 *
 * The plugin registers routes inside `ctx.effect` and disposes them (killing
 * both helpers) when the plugin unmounts. No route handler is allowed to
 * throw; every failure is answered as `{ok:false, code, message}`.
 *
 * @module dsh-screencapture
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCaptureEngine, hostError } from './capture.js'
import { isLoopbackRequest } from './fence.js'
import { createEventHub, createGlobalCaptureFlow } from './global-flow.js'
import { createHotkeyManager } from './hotkey.js'
import { makeRoutes } from './routes.js'

/** Cordis plugin name. */
export const name = 'dsh-screencapture'

/** Hard dependency: the host web server owns the HTTP routes. */
export const inject = ['webServer']

/** Package version reported by `GET /api/dsh-screencapture/status`. */
export const version = readPackageVersion()

/**
 * Read the bundle's own package.json version, falling back to a placeholder so
 * a missing manifest can never break plugin load.
 * @returns {string}
 */
function readPackageVersion() {
  try {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
  } catch {
    /* fall through to the placeholder */
  }
  return '0.0.0'
}

/**
 * Candidate process ids whose top-level window is "the DSH window". The Host
 * runs inside the Electron main process's Node mode; `process.ppid` is the
 * documented target, with our own pid as a fallback for compositions where the
 * host plugin process itself owns the window.
 * @returns {number[]}
 */
function dshWindowProcessCandidates() {
  const candidates = []
  if (Number.isInteger(process.ppid) && process.ppid > 0) candidates.push(process.ppid)
  if (Number.isInteger(process.pid) && process.pid > 0 && process.pid !== process.ppid) {
    candidates.push(process.pid)
  }
  return candidates
}

/**
 * Compose the host capability once: capture engine, global hotkey manager, SSE
 * hub, global capture flow, and the route table.
 *
 * Exported (in addition to being used by `apply`) so the tests exercise the
 * exact wiring that ships — with real or fake request/response objects —
 * without booting a Cordis context.
 *
 * @param {object} [options]
 * @param {{warn?: Function, info?: Function}} [options.logger] Cordis-style logger
 * @param {number} [options.commandTimeoutMs] capture-helper command timeout (tests)
 * @param {string} [options.hotkeySettingsPath] override the persisted hotkey settings path
 * @param {string} [options.hotkeyHelperScriptPath] override hotkey-helper.ps1
 * @param {Function} [options.hotkeySpawn] spawn seam for the hotkey helper (tests)
 * @param {number} [options.sseKeepAliveMs] SSE keep-alive cadence (tests)
 * @param {boolean} [options.loadStoredConfig] load/apply persisted hotkey on creation (default true)
 * @returns {{engine: object, hotkey: object, events: object, flow: object, routes: object[], version: string, startStoredHotkey: () => Promise<object>, close: () => Promise<void>}}
 */
export function createHost(options = {}) {
  const logger = options.logger
  const engine = createCaptureEngine({
    logger,
    commandTimeoutMs: options.commandTimeoutMs,
  })
  const hotkey = createHotkeyManager({
    logger,
    settingsPath: options.hotkeySettingsPath,
    helperScriptPath: options.hotkeyHelperScriptPath,
    spawn: options.hotkeySpawn,
    platform: options.platform,
  })
  const events = createEventHub({
    logger,
    keepAliveMs: options.sseKeepAliveMs,
  })
  /**
   * Run an operation against the DSH window with the same pid-candidate policy
   * for every window-related operation: `process.ppid` first, then our own pid.
   * @template T
   * @param {(pid: number) => Promise<T>} operation
   * @param {string} failureCode
   * @returns {Promise<T>}
   */
  const withDshWindowPid = async (operation, failureCode) => {
    let lastError = null
    for (const pid of dshWindowProcessCandidates()) {
      try {
        return await operation(pid)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || hostError(failureCode, 'no candidate DSH window process was found')
  }

  const flow = createGlobalCaptureFlow({
    capture: () => engine.capture(),
    events,
    logger,
    activate: () => withDshWindowPid(pid => engine.activate(pid), 'activate-failed'),
  })
  hotkey.onHotkey = () => {
    void flow.handleHotkey()
  }

  const routes = makeRoutes({
    fence: isLoopbackRequest,
    platform: process.platform,
    version,
    status: () => ({ ...engine.status(), globalHotkey: hotkey.status() }),
    capture: () => engine.capture(),
    clipboard: buffer => engine.setClipboardPng(buffer),
    events,
    lastCapture: () => flow.lastCapture(),
    configureGlobalHotkey: config => hotkey.configure(config),
    prepareOverlayWindow: () => withDshWindowPid(
      pid => engine.prepareOverlayWindow(pid),
      'overlay-prepare-failed',
    ),
    restoreOverlayWindow: () => engine.restoreOverlayWindow(),
  })

  let storedConfigStarted = false
  /**
   * Load and apply the persisted global-hotkey setting. Never rejects; a taken
   * chord or missing file only shows up in `status.globalHotkey`.
   * @returns {Promise<object>} hotkey status
   */
  const startStoredHotkey = () => {
    if (options.loadStoredConfig === false || storedConfigStarted) return Promise.resolve(hotkey.status())
    storedConfigStarted = true
    return hotkey.loadStoredConfig().catch((error) => {
      try {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`dsh-screencapture: could not load the persisted global hotkey: ${error instanceof Error ? error.message : error}`)
        }
      } catch {
        /* logging must never break plugin load */
      }
      return hotkey.status()
    })
  }

  /** Dispose the SSE streams, the global hotkey helper and the capture helper. */
  const close = async () => {
    events.close()
    await hotkey.close()
    // engine.close() first restores any pending overlay-window placement, so a
    // plugin unload can never leave the DSH window maximized.
    await engine.close()
  }

  return { engine, hotkey, events, flow, routes, version, startStoredHotkey, close }
}

/**
 * Cordis plugin apply: register the /api/dsh-screencapture route family under an
 * effect that disposes the routes and kills both warm helpers on unmount. The
 * persisted global hotkey is applied asynchronously so a taken chord (or a
 * missing PowerShell helper) can never fail plugin load.
 * @param {import('@deepseek-ai/cordis').Context} ctx host plugin context
 */
export async function apply(ctx) {
  const host = createHost({ logger: ctx.logger })
  // One lifecycle effect owns the whole Host side: the route registrations, the
  // persisted-hotkey helper start, and the helper teardown. Returning close()
  // lets the framework wait for the async cleanup instead of fire-and-forget.
  ctx.effect(() => {
    const disposers = host.routes.map(route => ctx.webServer.register(route))
    // Never rejects (a taken chord is reported through status.globalHotkey).
    void host.startStoredHotkey()
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* a duplicate mount already removed it */
        }
      }
      // close() restores a pending overlay placement, then terminates both
      // helpers; returning the promise keeps the fiber teardown ordered.
      return host.close()
    }
  }, 'dsh-screencapture: host lifecycle')
}
