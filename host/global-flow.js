/**
 * dsh-screencapture — SSE event hub and OS-global capture flow.
 *
 * The global hotkey lives in the Host (see host/hotkey.js): pressing it while
 * ANY application is focused captures the whole desktop, caches the bitmap in
 * memory as "the last capture", brings the DSH window forward, and broadcasts a
 * `capture` Server-Sent-Events frame. The browser half listens on
 * `GET /api/dsh-screencapture/events`, then fetches `GET /api/dsh-screencapture/last-capture`
 * and opens the frozen overlay.
 *
 * Event frames (SSE, `text/event-stream`):
 *   event: capture          data: {"seq":1,"width":2560,"height":1440,"capturedAt":"..."}
 *   event: capture-failed   data: {"code":"capture-failed","message":"..."}
 *
 * @module dsh-screencapture/host/global-flow
 */

/** Comment heartbeat cadence for connected SSE clients. */
export const SSE_KEEP_ALIVE_MS = 15_000

const EVENT_STREAM_HEADERS = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  connection: 'keep-alive',
})

/**
 * Create the SSE hub: a set of connected response streams that receive named
 * events. Subscribing writes the stream headers and an immediate comment
 * heartbeat; a 15 s comment keeps proxies from closing the stream. Closing the
 * request or calling `close()` removes and ends the client.
 *
 * @param {object} [options]
 * @param {number} [options.keepAliveMs]
 * @param {{warn?: Function, info?: Function}} [options.logger]
 * @returns {{subscribe: Function, emit: (name: string, data: unknown) => void, close: () => void, readonly clientCount: number}}
 */
export function createEventHub(options = {}) {
  const keepAliveMs = options.keepAliveMs === undefined ? SSE_KEEP_ALIVE_MS : options.keepAliveMs
  const logger = options.logger
  const clients = new Set()
  let closed = false

  const log = (level, message) => {
    try {
      const write = logger && (logger[level] || logger.info)
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      /* logging must never break the event stream */
    }
  }

  const removeClient = (client) => {
    if (!clients.delete(client)) return
    if (client.timer) clearInterval(client.timer)
    try {
      client.res.end()
    } catch {
      /* the peer is already gone */
    }
  }

  /**
   * Attach one SSE client. The route handler returns after this call and the
   * response stays open until the client disconnects or the hub is closed.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {() => void} unsubscribe
   */
  const subscribe = (req, res) => {
    if (closed) {
      try {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, code: 'engine-closed', message: 'the event stream is closed' }))
      } catch {
        /* peer already gone */
      }
      return () => {}
    }
    res.writeHead(200, { ...EVENT_STREAM_HEADERS })
    try {
      res.write(': connected\n\n')
    } catch {
      /* peer already gone */
    }
    const client = { req, res, timer: null }
    client.timer = setInterval(() => {
      try {
        res.write(': keep-alive\n\n')
      } catch {
        removeClient(client)
      }
    }, keepAliveMs)
    if (client.timer && typeof client.timer.unref === 'function') client.timer.unref()
    clients.add(client)
    const cleanup = () => removeClient(client)
    if (req && typeof req.on === 'function') {
      req.on('close', cleanup)
      req.on('error', cleanup)
    }
    return cleanup
  }

  /**
   * Broadcast one named SSE event to every connected client.
   * @param {string} name event name (`capture`, `capture-failed`)
   * @param {unknown} data JSON-serializable payload
   */
  const emit = (name, data) => {
    if (closed) return
    let frame
    try {
      frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    } catch (error) {
      log('warn', `dsh-screencapture: could not serialize SSE event ${name}: ${error instanceof Error ? error.message : error}`)
      return
    }
    for (const client of [...clients]) {
      try {
        client.res.write(frame)
      } catch {
        removeClient(client)
      }
    }
  }

  /** End every connected stream and refuse new subscriptions. */
  const close = () => {
    if (closed) return
    closed = true
    for (const client of [...clients]) removeClient(client)
  }

  return {
    subscribe,
    emit,
    close,
    get clientCount() {
      return clients.size
    },
  }
}

/**
 * Create the OS-global capture flow: capture → cache last capture → activate
 * the DSH window → broadcast `capture`. A capture already in flight makes the
 * next hotkey press a no-op; a failed capture broadcasts `capture-failed`.
 *
 * @param {object} deps
 * @param {() => Promise<{dataUrl: string, width: number, height: number, screens: object[], windows?: object[], capturedAt?: string}>} deps.capture
 * @param {() => Promise<void>} deps.activate bring the DSH window forward
 * @param {{emit: (name: string, data: unknown) => void}} deps.events SSE hub
 * @param {() => Date} [deps.now]
 * @param {{warn?: Function, info?: Function}} [deps.logger]
 * @returns {{handleHotkey: () => Promise<object>, lastCapture: () => object|null, readonly busy: boolean}}
 */
export function createGlobalCaptureFlow(deps) {
  const { capture, activate, events } = deps
  const now = deps.now || (() => new Date())
  const logger = deps.logger
  let lastCaptureResult = null
  let seq = 0
  let inFlight = false

  const log = (level, message) => {
    try {
      const write = logger && (logger[level] || logger.info)
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      /* logging must never break the flow */
    }
  }

  /**
   * Run one global capture cycle. Never throws.
   * @returns {Promise<{ok: boolean, seq?: number, ignored?: boolean, code?: string, message?: string}>}
   */
  const handleHotkey = async () => {
    if (inFlight) {
      log('info', 'dsh-screencapture: global hotkey pressed while a capture is already in flight; ignored')
      return { ok: false, ignored: true }
    }
    inFlight = true
    try {
      const result = await capture()
      seq += 1
      const capturedAt = typeof result.capturedAt === 'string' && result.capturedAt !== ''
        ? result.capturedAt
        : now().toISOString()
      lastCaptureResult = {
        image: {
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
        },
        screens: Array.isArray(result.screens) ? result.screens.map(screen => ({ ...screen })) : [],
        // Virtual-desktop origin/rect, needed to map window rects to image pixels.
        virtual: result.virtual ? { ...result.virtual } : null,
        // Captured-time window list (Z-order, topmost first) for hover snapping.
        windows: Array.isArray(result.windows) ? result.windows.map(window => ({ ...window })) : [],
        capturedAt,
        seq,
      }
      try {
        await activate()
      } catch (error) {
        // The capture itself succeeded; a failed foreground activation only
        // means the user has to click the DSH window to see the overlay.
        log('warn', `dsh-screencapture: could not activate the DSH window: ${error instanceof Error ? error.message : error}`)
      }
      events.emit('capture', {
        seq,
        width: result.width,
        height: result.height,
        capturedAt,
      })
      return { ok: true, seq }
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'capture-failed'
      const message = error instanceof Error ? error.message : String(error)
      log('warn', `dsh-screencapture: global capture failed: ${message}`)
      events.emit('capture-failed', { code, message })
      return { ok: false, code, message }
    } finally {
      inFlight = false
    }
  }

  /**
   * The cached last global capture (single slot), or null before the first one.
   * @returns {null | {image: {dataUrl: string, width: number, height: number}, screens: object[], windows: object[], capturedAt: string, seq: number}}
   */
  const lastCapture = () => {
    if (!lastCaptureResult) return null
    return {
      image: { ...lastCaptureResult.image },
      screens: lastCaptureResult.screens.map(screen => ({ ...screen })),
      virtual: lastCaptureResult.virtual ? { ...lastCaptureResult.virtual } : null,
      windows: lastCaptureResult.windows.map(window => ({ ...window })),
      capturedAt: lastCaptureResult.capturedAt,
      seq: lastCaptureResult.seq,
    }
  }

  return {
    handleHotkey,
    lastCapture,
    get busy() {
      return inFlight
    },
  }
}
