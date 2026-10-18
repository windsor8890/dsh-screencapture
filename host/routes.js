/**
 * dsh-screencapture — HTTP route table for the native capture/clipboard/save
 * capability.
 *
 * Five core routes are registered on `ctx.webServer` by host/index.js:
 *
 *   GET  /api/dsh-screencapture/status
 *   POST /api/dsh-screencapture/capture    { }
 *   POST /api/dsh-screencapture/clipboard  { dataUrl }
 *   POST /api/dsh-screencapture/save       { dataUrl, directory? }
 *   POST /api/dsh-screencapture/reveal     { path }
 *
 * plus the Phase-B OS-global-hotkey family:
 *
 *   GET  /api/dsh-screencapture/events       text/event-stream (`capture`, `capture-failed`)
 *   GET  /api/dsh-screencapture/last-capture cached global capture or 404 no-capture
 *   POST /api/dsh-screencapture/config       { enabled, shortcut|null } → { globalHotkey }
 *
 * and the overlay-window helper (temporary maximize while the overlay is open):
 *
 *   POST /api/dsh-screencapture/overlay-window  { action: 'prepare' | 'restore' }
 *
 * `/capture` and `/last-capture` additionally carry `windows`: the Z-ordered
 * (topmost first) top-level window list captured at the same moment as the
 * screenshot, used by the overlay for hover-to-snap window selection, plus the
 * `virtual` desktop rect used to map window coordinates onto image pixels.
 *
 * Every handler owns its whole response: it always answers explicit JSON and
 * never throws (a throwing handler becomes an empty HTTP 400 in the web
 * server). Requests are fenced to the loopback socket + loopback Host trust
 * boundary, and JSON bodies are capped at 64 MiB while decoded images are
 * capped at 48 MiB.
 *
 * The implementation is a pure builder with injectable dependencies (fence,
 * status, capture, clipboard, save, reveal) so the whole route family can be
 * exercised with fake request/response objects.
 *
 * @module dsh-screencapture/host/routes
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isLoopbackRequest } from './fence.js'

/** Route paths (exact matches). */
export const ROUTE_PATHS = Object.freeze({
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

/** Contract: JSON request bodies are capped at 64 MiB. */
export const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024

/** Contract: decoded image payloads are capped at 48 MiB. */
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024

/** Contract: only PNG data URLs are accepted. */
export const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

/** Contract: default save directory name under `%USERPROFILE%\Pictures`. */
export const DEFAULT_SAVE_DIRECTORY_NAME = 'DSH Screenshots'

/** Contract: `Screenshot_YYYYMMDD_HHmmss_SSS.png`. */
export const SAVE_FILE_PATTERN = /^Screenshot_\d{8}_\d{6}_\d{3}\.png$/

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ZERO_RECT = Object.freeze({ x: 0, y: 0, width: 0, height: 0 })
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
})

/**
 * HTTP status for a stable error code. Unknown internal failures map to 500.
 * @type {Record<string, number>}
 */
const HTTP_STATUS_BY_CODE = {
  forbidden: 403,
  'method-not-allowed': 405,
  'body-too-large': 413,
  'image-too-large': 413,
  'bad-json': 400,
  'bad-body': 400,
  'invalid-dataurl': 400,
  'invalid-image': 400,
  'invalid-directory': 400,
  'invalid-path': 400,
  'invalid-config': 400,
  'invalid-shortcut': 400,
  'invalid-action': 400,
  'unsupported-platform': 501,
  'engine-closed': 503,
  'capture-failed': 500,
  'clipboard-failed': 500,
  'save-failed': 500,
  'reveal-failed': 500,
  'hotkey-failed': 500,
  'overlay-prepare-failed': 500,
  'overlay-restore-failed': 500,
  'internal-error': 500,
}

/**
 * Create an Error carrying a stable machine-readable `code`.
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function routeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPngBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= PNG_SIGNATURE.length
    && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** Turn any thrown value into the contract's `{ok:false, code, message}`. */
function writeError(res, error) {
  const code = error && typeof error.code === 'string' && error.code !== ''
    ? error.code
    : 'internal-error'
  const status = HTTP_STATUS_BY_CODE[code] || 500
  writeJson(res, status, { ok: false, code, message: errorMessage(error) })
}

/**
 * Wrap a handler so a throw can never escape to the web server: it answers a
 * JSON 500 instead.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler
 */
function safeHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      try {
        if (res.headersSent) {
          res.end()
          return
        }
        writeError(res, error)
      } catch {
        try {
          res.destroy()
        } catch {
          /* the socket is already gone */
        }
      }
    }
  }
}

/**
 * Read and parse a bounded JSON object body. `{}` when the body is empty.
 * A body past the cap is drained (so the response can still be sent, rather
 * than resetting the connection) and rejected.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  let overflow = false
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (overflow) continue
      size += buffer.length
      if (size > maxBytes) {
        overflow = true
        chunks.length = 0
        continue
      }
      chunks.push(buffer)
    }
  } catch (error) {
    throw routeError('bad-body', `could not read the request body: ${errorMessage(error)}`)
  }
  if (overflow) throw routeError('body-too-large', `the JSON body exceeds the ${maxBytes} byte limit`)
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw routeError('bad-json', 'the request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw routeError('bad-json', 'the request body must be a JSON object')
  }
  return parsed
}

/**
 * Validate and decode a PNG data URL.
 * @param {unknown} dataUrl
 * @param {number} [maxImageBytes]
 * @returns {Buffer} decoded PNG bytes
 */
export function decodePngDataUrl(dataUrl, maxImageBytes = MAX_IMAGE_BYTES) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw routeError('invalid-dataurl', 'dataUrl must be a PNG data URL string')
  }
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw routeError('invalid-dataurl', `dataUrl must start with "${PNG_DATA_URL_PREFIX}"`)
  }
  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length)
  if (base64.length === 0) throw routeError('invalid-dataurl', 'dataUrl carries no image data')
  if (!/^[A-Za-z0-9+/=\s]*$/.test(base64)) {
    throw routeError('invalid-dataurl', 'dataUrl is not valid base64')
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const estimatedBytes = Math.floor((base64.length * 3) / 4) - padding
  if (estimatedBytes > maxImageBytes) {
    throw routeError('image-too-large', `the decoded image exceeds the ${maxImageBytes} byte limit`)
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw routeError('invalid-dataurl', 'dataUrl carries no image data')
  if (buffer.length > maxImageBytes) {
    throw routeError('image-too-large', `the decoded image exceeds the ${maxImageBytes} byte limit`)
  }
  if (!isPngBuffer(buffer)) throw routeError('invalid-image', 'dataUrl does not contain a PNG image')
  return buffer
}

/**
 * Resolve the directory a screenshot is saved into. An empty/absent request
 * directory means the host default.
 * @param {unknown} requested
 * @returns {string} absolute directory path
 */
export function resolveSaveDirectory(requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested.trim())
  return join(homedir(), 'Pictures', DEFAULT_SAVE_DIRECTORY_NAME)
}

/**
 * Validate the optional `directory` request field.
 * @param {unknown} requested
 * @returns {string | undefined} absolute directory, or undefined for default
 */
export function normalizeSaveDirectory(requested) {
  if (requested === undefined || requested === null) return undefined
  if (typeof requested !== 'string') throw routeError('invalid-directory', 'directory must be a string')
  const trimmed = requested.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > 1024) throw routeError('invalid-directory', 'directory is too long')
  return resolve(trimmed)
}

/**
 * Format the contract file-name timestamp: local time, `YYYYMMDD_HHmmss_SSS`.
 * @param {Date} [date]
 * @returns {string}
 */
export function formatFileStamp(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `_${pad(date.getMilliseconds(), 3)}`
}

/** Sleep helper for the rare same-millisecond file-name collision. */
function delayMs(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

/**
 * Write `buffer` as a uniquely named PNG inside `directory`, claiming the file
 * atomically with an exclusive create so two concurrent saves cannot clobber
 * each other.
 * @param {string} directory
 * @param {Buffer} buffer
 * @returns {Promise<string>} written path
 */
async function writeUniqueScreenshot(directory, buffer) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const filePath = join(directory, `Screenshot_${formatFileStamp(new Date())}.png`)
    let handle
    try {
      handle = await open(filePath, 'wx')
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        await delayMs(2)
        continue
      }
      throw error
    }
    try {
      await handle.writeFile(buffer)
      return filePath
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => {})
      throw error
    } finally {
      await handle.close().catch(() => {})
    }
  }
  throw routeError('save-failed', 'could not allocate a unique screenshot file name')
}

/**
 * Default save implementation: create the directory and write the PNG.
 * @param {Buffer} buffer
 * @param {unknown} requestedDirectory
 * @returns {Promise<{path: string, directory: string}>}
 */
export async function savePngFile(buffer, requestedDirectory) {
  try {
    const directory = resolveSaveDirectory(requestedDirectory)
    await mkdir(directory, { recursive: true })
    const filePath = await writeUniqueScreenshot(directory, buffer)
    return { path: filePath, directory }
  } catch (error) {
    if (error && error.code === 'save-failed') throw error
    throw routeError('save-failed', `could not save the screenshot: ${errorMessage(error)}`)
  }
}

/**
 * Default reveal implementation: `explorer.exe /select,<path>`. The path is
 * passed as a single argv element — never concatenated into a shell string.
 * @param {string} target
 * @returns {Promise<void>}
 */
export function revealPath(target) {
  if (existsSync(target) === false) {
    // The file is gone: reveal should still not open an unrelated folder.
    return Promise.reject(routeError('reveal-failed', 'the requested path does not exist'))
  }
  return new Promise((resolveReveal, rejectReveal) => {
    let child
    try {
      child = spawn('explorer.exe', [`/select,${target}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (error) {
      rejectReveal(routeError('reveal-failed', `could not start explorer: ${errorMessage(error)}`))
      return
    }
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      rejectReveal(routeError('reveal-failed', `could not start explorer: ${errorMessage(error)}`))
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      try {
        child.unref()
      } catch {
        /* the process may already have exited */
      }
      resolveReveal()
    })
  })
}

/**
 * Build the route table.
 *
 * @param {object} deps
 * @param {(req: import('node:http').IncomingMessage) => boolean} [deps.fence] loopback fence
 * @param {() => {helper: string, screens: object[], virtual: {x:number,y:number,width:number,height:number}} | Promise<object>} [deps.status]
 * @param {() => Promise<{dataUrl: string, width: number, height: number, screens: object[], virtual: object}>} [deps.capture]
 * @param {(buffer: Buffer) => Promise<void>} [deps.clipboard]
 * @param {(buffer: Buffer, directory: unknown) => Promise<{path: string, directory: string}>} [deps.save]
 * @param {(path: string) => Promise<void>} [deps.reveal]
 * @param {{subscribe: Function}} [deps.events] SSE hub for `/events`
 * @param {() => object|null} [deps.lastCapture] cached global-hotkey capture
 * @param {(config: {enabled: boolean, shortcut: unknown}) => Promise<object>} [deps.configureGlobalHotkey]
 * @param {() => Promise<{ok: boolean, changed: boolean}>} [deps.prepareOverlayWindow] temporarily maximize the DSH window for the overlay
 * @param {() => Promise<{ok: boolean, restored: boolean}>} [deps.restoreOverlayWindow] restore the remembered window placement
 * @param {string} [deps.platform] `process.platform` value
 * @param {string} [deps.version] reported plugin version
 * @param {number} [deps.maxBodyBytes] JSON body cap (contract 64 MiB)
 * @param {number} [deps.maxImageBytes] decoded image cap (contract 48 MiB)
 * @param {() => Date} [deps.now]
 * @returns {Array<{kind: 'exact', path: string, handler: Function}>} routes to register
 */
export function makeRoutes(deps = {}) {
  const fence = deps.fence || isLoopbackRequest
  const platform = deps.platform || process.platform
  const version = deps.version || '1.0.0'
  const maxBodyBytes = deps.maxBodyBytes === undefined ? MAX_JSON_BODY_BYTES : deps.maxBodyBytes
  const maxImageBytes = deps.maxImageBytes === undefined ? MAX_IMAGE_BYTES : deps.maxImageBytes
  const now = deps.now || (() => new Date())
  const status = deps.status || (() => ({ helper: 'idle', screens: [], virtual: { ...ZERO_RECT } }))
  const capture = deps.capture || (async () => {
    throw routeError('capture-failed', 'no capture implementation is mounted')
  })
  const clipboard = deps.clipboard || (async () => {
    throw routeError('clipboard-failed', 'no clipboard implementation is mounted')
  })
  const save = deps.save || savePngFile
  const reveal = deps.reveal || revealPath
  const events = deps.events || null
  const lastCapture = deps.lastCapture || (() => null)
  const configureGlobalHotkey = deps.configureGlobalHotkey || (async () => {
    throw routeError('hotkey-failed', 'no global hotkey implementation is mounted')
  })
  const prepareOverlayWindow = deps.prepareOverlayWindow || (async () => {
    throw routeError('overlay-prepare-failed', 'no overlay-window implementation is mounted')
  })
  const restoreOverlayWindow = deps.restoreOverlayWindow || (async () => {
    throw routeError('overlay-restore-failed', 'no overlay-window implementation is mounted')
  })

  /** Method guard: answer 405 and return false when the method is wrong. */
  const requireMethod = (req, res, method) => {
    if (req.method === method) return true
    writeJson(res, 405, {
      ok: false,
      code: 'method-not-allowed',
      message: `this route expects ${method}`,
    })
    return false
  }

  /** Trust-boundary guard: answer 403 and return false for non-loopback requests. */
  const requireTrusted = (req, res) => {
    if (fence(req)) return true
    writeJson(res, 403, {
      ok: false,
      code: 'forbidden',
      message: 'this route is only reachable from a loopback request',
    })
    return false
  }

  /** Platform guard: answer 501 and return false outside Windows. */
  const requireWindows = (res) => {
    if (platform === 'win32') return true
    writeJson(res, 501, {
      ok: false,
      code: 'unsupported-platform',
      message: 'native screen capture is only implemented on Windows',
    })
    return false
  }

  const handleStatus = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    if (!requireTrusted(req, res)) return
    const snapshot = await status()
    writeJson(res, 200, {
      ok: true,
      platform,
      helper: snapshot.helper,
      screens: snapshot.screens,
      virtual: snapshot.virtual,
      version,
      globalHotkey: snapshot.globalHotkey || { enabled: false, registered: false, shortcut: null, error: null },
    })
  })

  const handleCapture = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    if (!requireTrusted(req, res)) return
    if (!requireWindows(res)) return
    // The documented body is `{}`; parse it anyway so a malformed body gets a
    // JSON 400 instead of being silently ignored.
    await readJsonBody(req, maxBodyBytes)
    const result = await capture()
    writeJson(res, 200, {
      ok: true,
      image: {
        dataUrl: result.dataUrl,
        width: result.width,
        height: result.height,
      },
      screens: result.screens,
      // Virtual-desktop origin/rect: image pixel = window coordinate - virtual origin.
      virtual: result.virtual,
      // Captured-time window list in Z-order (topmost first) for hover snapping.
      windows: Array.isArray(result.windows) ? result.windows : [],
      capturedAt: result.capturedAt || now().toISOString(),
    })
  })

  const handleClipboard = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    if (!requireTrusted(req, res)) return
    if (!requireWindows(res)) return
    const body = await readJsonBody(req, maxBodyBytes)
    const png = decodePngDataUrl(body.dataUrl, maxImageBytes)
    await clipboard(png)
    writeJson(res, 200, { ok: true })
  })

  const handleSave = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    if (!requireTrusted(req, res)) return
    if (!requireWindows(res)) return
    const body = await readJsonBody(req, maxBodyBytes)
    const directory = normalizeSaveDirectory(body.directory)
    const png = decodePngDataUrl(body.dataUrl, maxImageBytes)
    const result = await save(png, directory)
    writeJson(res, 200, { ok: true, path: result.path, directory: result.directory })
  })

  const handleReveal = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    if (!requireTrusted(req, res)) return
    if (!requireWindows(res)) return
    const body = await readJsonBody(req, maxBodyBytes)
    const target = body.path
    if (typeof target !== 'string' || target.trim() === '') {
      throw routeError('invalid-path', 'path must be a non-empty string')
    }
    if (target.length > 4096) throw routeError('invalid-path', 'path is too long')
    await reveal(target)
    writeJson(res, 200, { ok: true })
  })

  // --- OS-global hotkey / SSE routes ---------------------------------------

  const handleEvents = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    if (!requireTrusted(req, res)) return
    if (!events) throw routeError('engine-closed', 'the event stream is not mounted')
    // Keeps the response open; the hub ends it on disconnect or dispose.
    events.subscribe(req, res)
  })

  const handleLastCapture = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    if (!requireTrusted(req, res)) return
    const captureRecord = await lastCapture()
    if (!captureRecord) {
      writeJson(res, 404, { ok: false, code: 'no-capture', message: 'no global capture has been taken yet' })
      return
    }
    const payload = {
      ok: true,
      image: captureRecord.image,
      screens: captureRecord.screens,
      // Window list captured with the global-hotkey screenshot (hover snapping).
      windows: Array.isArray(captureRecord.windows) ? captureRecord.windows : [],
      capturedAt: captureRecord.capturedAt,
      seq: captureRecord.seq,
    }
    if (captureRecord.virtual) payload.virtual = captureRecord.virtual
    writeJson(res, 200, payload)
  })

  const handleConfig = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    if (!requireTrusted(req, res)) return
    const body = await readJsonBody(req, maxBodyBytes)
    if (typeof body.enabled !== 'boolean') {
      throw routeError('invalid-config', 'enabled must be a boolean')
    }
    const shortcut = body.shortcut === undefined || body.shortcut === null ? null : body.shortcut
    const globalHotkey = await configureGlobalHotkey({ enabled: body.enabled, shortcut })
    writeJson(res, 200, { ok: true, globalHotkey })
  })

  // --- overlay window (temporary maximize while the overlay is open) ------

  const handleOverlayWindow = safeHandler(async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    if (!requireTrusted(req, res)) return
    if (!requireWindows(res)) return
    const body = await readJsonBody(req, maxBodyBytes)
    const action = body.action
    if (action === 'prepare') {
      const result = await prepareOverlayWindow()
      writeJson(res, 200, { ok: true, changed: Boolean(result && result.changed), prepared: true })
      return
    }
    if (action === 'restore') {
      const result = await restoreOverlayWindow()
      writeJson(res, 200, { ok: true, restored: Boolean(result && result.restored) })
      return
    }
    throw routeError('invalid-action', 'action must be "prepare" or "restore"')
  })

  return [
    { kind: 'exact', path: ROUTE_PATHS.status, handler: handleStatus },
    { kind: 'exact', path: ROUTE_PATHS.capture, handler: handleCapture },
    { kind: 'exact', path: ROUTE_PATHS.clipboard, handler: handleClipboard },
    { kind: 'exact', path: ROUTE_PATHS.save, handler: handleSave },
    { kind: 'exact', path: ROUTE_PATHS.reveal, handler: handleReveal },
    { kind: 'exact', path: ROUTE_PATHS.events, handler: handleEvents },
    { kind: 'exact', path: ROUTE_PATHS.lastCapture, handler: handleLastCapture },
    { kind: 'exact', path: ROUTE_PATHS.config, handler: handleConfig },
    { kind: 'exact', path: ROUTE_PATHS.overlayWindow, handler: handleOverlayWindow },
  ]
}
