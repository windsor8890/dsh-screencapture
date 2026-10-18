/* ============================================================================
 * dsh-screencapture client :: shared foundation
 * Settings store, host-API calls, overlay/toast stores, chord helpers, icons,
 * translated copy and stylesheet injection. All of it is plain JavaScript in
 * the bundle factory scope (see build.mjs); nothing here has side effects at
 * factory time except pure function/const definitions.
 * ========================================================================== */

/** Host API prefix registered by host/routes.js. */
const SHOT_API = '/api/dsh-screencapture'
/** localStorage key of the user preferences. */
const SHOT_SETTINGS_KEY = 'dsh-screencapture.settings.v1'
/** Locale namespace of the client half. */
const SHOT_LOCALE_NS = 'dsh-screencapture'

/** Factory defaults; also the reset target of the settings page.
 * Ctrl+Shift+S: the shipped DSH composition already binds Ctrl+Shift+A
 * (ui-workspace "archive session" menu shortcut), and the Electron shell
 * consumes app shortcuts before the page sees them, so that chord can never
 * reach this listener. */
const SHOT_DEFAULT_SETTINGS = {
  shortcut: { code: 'KeyS', ctrl: true, shift: true, alt: false, meta: false },
  autoSave: false,
  saveDirectory: '',
  globalHotkey: true,
}

/* -------------------------------------------------------------------------- */
/* errors, helpers                                                            */
/* -------------------------------------------------------------------------- */

class ShotError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ShotError'
    this.code = code || 'unknown'
  }
}

function shotClassNames() {
  let out = ''
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i]
    if (typeof value === 'string' && value.length > 0) out = out ? out + ' ' + value : value
  }
  return out
}

function shotClamp(value, low, high) {
  return value < low ? low : value > high ? high : value
}

/* -------------------------------------------------------------------------- */
/* settings store (localStorage, lazily initialized)                          */
/* -------------------------------------------------------------------------- */

let shotSettingsCache = null
const shotSettingsListeners = new Set()

function shotNormalizeChord(value, fallback) {
  const base = fallback || SHOT_DEFAULT_SETTINGS.shortcut
  if (value === null || typeof value !== 'object') return { ...base }
  const code = typeof value.code === 'string' && value.code.length > 0 ? value.code : base.code
  return {
    code,
    ctrl: value.ctrl === true,
    shift: value.shift === true,
    alt: value.alt === true,
    meta: value.meta === true,
  }
}

function shotNormalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    shortcut: shotNormalizeChord(source.shortcut, SHOT_DEFAULT_SETTINGS.shortcut),
    autoSave: source.autoSave === true,
    saveDirectory: typeof source.saveDirectory === 'string' ? source.saveDirectory : '',
    globalHotkey: source.globalHotkey !== false,
  }
}

function shotReadSettings() {
  if (shotSettingsCache !== null) return shotSettingsCache
  let parsed = null
  try {
    const raw = window.localStorage.getItem(SHOT_SETTINGS_KEY)
    parsed = raw === null ? null : JSON.parse(raw)
  } catch (error) {
    parsed = null
  }
  shotSettingsCache = shotNormalizeSettings(parsed)
  return shotSettingsCache
}

function shotWriteSettings(patch) {
  const current = shotReadSettings()
  const next = shotNormalizeSettings({ ...current, ...patch })
  shotSettingsCache = next
  try {
    window.localStorage.setItem(SHOT_SETTINGS_KEY, JSON.stringify(next))
  } catch (error) {
    /* private mode / quota: keep the in-memory value */
  }
  for (const listener of shotSettingsListeners) {
    try {
      listener(next)
    } catch (error) {
      /* subscriber errors must not break the writer */
    }
  }
  return next
}

function shotSubscribeSettings(listener) {
  shotSettingsListeners.add(listener)
  return function unsubscribe() {
    shotSettingsListeners.delete(listener)
  }
}

/** React hook over the settings store (uSES-compatible snapshot). */
function shotUseSettings() {
  const snapshot = React.useSyncExternalStore(
    shotSubscribeSettings,
    shotReadSettings,
    shotReadSettings,
  )
  return snapshot
}

/* -------------------------------------------------------------------------- */
/* chord helpers                                                              */
/* -------------------------------------------------------------------------- */

const SHOT_MODIFIER_CODES = {
  ControlLeft: 'ctrl',
  ControlRight: 'ctrl',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  AltLeft: 'alt',
  AltRight: 'alt',
  MetaLeft: 'meta',
  MetaRight: 'meta',
  OSLeft: 'meta',
  OSRight: 'meta',
}

const SHOT_CODE_LABELS = {
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyG: 'G',
  KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L', KeyM: 'M', KeyN: 'N',
  KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R', KeyS: 'S', KeyT: 'T', KeyU: 'U',
  KeyV: 'V', KeyW: 'W', KeyX: 'X', KeyY: 'Y', KeyZ: 'Z',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8',
  F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Insert: 'Insert', Delete: 'Delete', PrintScreen: 'PrintScreen', Pause: 'Pause',
  Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3', Numpad4: 'Num4',
  Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7', Numpad8: 'Num8', Numpad9: 'Num9',
}

function shotCodeLabel(code) {
  if (typeof SHOT_CODE_LABELS[code] === 'string') return SHOT_CODE_LABELS[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  return code || '?'
}

/**
 * KeyboardEvent.code values the Host's Win32 accelerator table can register.
 * Keep this in sync with `host/hotkey.js`; the recorder rejects anything else so
 * a user can never save a chord that the global-hotkey route would refuse.
 */
const SHOT_SUPPORTED_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete',
  'Space', 'Enter', 'Tab', 'Escape', 'Backspace',
  'CapsLock', 'NumLock', 'ScrollLock',
  'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote',
  'BracketLeft', 'Backslash', 'BracketRight', 'Quote',
  'NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide',
])

function shotIsHostSupportedCode(code) {
  if (typeof code !== 'string' || code.length === 0) return false
  if (/^Key[A-Z]$/.test(code)) return true
  if (/^Digit[0-9]$/.test(code)) return true
  if (/^Numpad[0-9]$/.test(code)) return true
  if (/^F([1-9]|1[0-2])$/.test(code)) return true
  return SHOT_SUPPORTED_CODES.has(code)
}

/** A chord qualifies when it has a supported key plus at least one modifier. */
function shotIsEligibleChord(chord) {
  if (chord === null || typeof chord !== 'object' || typeof chord.code !== 'string') return false
  if (chord.code.length === 0) return false
  if (SHOT_MODIFIER_CODES[chord.code] !== undefined) return false
  if (!shotIsHostSupportedCode(chord.code)) return false
  return chord.ctrl === true || chord.alt === true || chord.meta === true
}

/** The chord that a keyboard event represents, with modifier-only events as null. */
function shotChordFromEvent(event) {
  if (event === null || typeof event !== 'object') return null
  if (SHOT_MODIFIER_CODES[event.code] !== undefined) return null
  if (typeof event.code !== 'string' || event.code.length === 0) return null
  return {
    code: event.code,
    ctrl: event.ctrlKey === true,
    shift: event.shiftKey === true,
    alt: event.altKey === true,
    meta: event.metaKey === true,
  }
}

function shotChordsEqual(a, b) {
  return a !== null && b !== null
    && a.code === b.code
    && a.ctrl === b.ctrl
    && a.shift === b.shift
    && a.alt === b.alt
    && a.meta === b.meta
}

/** Human key label of a chord code, used when the event carries no physical code. */
function shotKeyLabelOfCode(code) {
  if (typeof code !== 'string' || code.length === 0) return ''
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const keyNames = {
    Escape: 'Escape', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Space: ' ',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    Delete: 'Delete', Backspace: 'Backspace', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
    Period: '.', Slash: '/', Backquote: '`',
  }
  if (Object.hasOwn(keyNames, code)) return keyNames[code]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return ''
}

/**
 * Match a keyboard event against a recorded chord. Physical `event.code` is the
 * primary identity; synthetic input sources (automation tools, some accessibility
 * paths) can omit it, so a label-based fallback keeps the shortcut usable.
 */
function shotEventMatchesChord(event, chord) {
  if (event === null || chord === null || typeof chord !== 'object') return false
  if (event.ctrlKey !== chord.ctrl || event.shiftKey !== chord.shift
    || event.altKey !== chord.alt || event.metaKey !== chord.meta) return false
  if (event.code === chord.code) return true
  if (event.code !== '' && event.code !== 'Unidentified') return false
  const expected = shotKeyLabelOfCode(chord.code)
  if (expected === '') return false
  if (typeof event.key !== 'string') return false
  return event.key.toUpperCase() === expected.toUpperCase()
}

function shotFormatChord(chord) {
  if (chord === null || typeof chord !== 'object') return ''
  const parts = []
  if (chord.ctrl === true) parts.push('Ctrl')
  if (chord.alt === true) parts.push('Alt')
  if (chord.shift === true) parts.push('Shift')
  if (chord.meta === true) parts.push('Meta')
  parts.push(shotCodeLabel(chord.code))
  return parts.join(' + ')
}

/* -------------------------------------------------------------------------- */
/* host API                                                                   */
/* -------------------------------------------------------------------------- */

async function shotHostJson(path, body, timeoutMs) {
  const controller = new AbortController()
  const timer = window.setTimeout(function abortRequest() { controller.abort() }, timeoutMs || 30000)
  try {
    let response
    if (body === undefined) {
      response = await fetch(SHOT_API + path, { method: 'GET', signal: controller.signal })
    } else {
      response = await fetch(SHOT_API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }
    let payload = null
    try {
      payload = await response.json()
    } catch (error) {
      payload = null
    }
    if (!response.ok || payload === null || payload.ok !== true) {
      const message = payload !== null && typeof payload.message === 'string'
        ? payload.message
        : 'HTTP ' + String(response.status)
      const code = payload !== null && typeof payload.code === 'string' ? payload.code : 'http'
      throw new ShotError(message, code)
    }
    return payload
  } catch (error) {
    if (error instanceof ShotError) throw error
    if (error !== null && error.name === 'AbortError') throw new ShotError(tShot('timeoutError'), 'timeout')
    throw new ShotError(error !== null && typeof error.message === 'string' ? error.message : tShot('networkError'), 'network')
  } finally {
    window.clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* overlay store                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Immutable snapshot published to React through useSyncExternalStore; every
 * write replaces the object so subscribers always observe a new reference.
 * phase: 'idle' | 'capturing' | 'ready'
 * shot:  { dataUrl, width, height } (natural pixels)
 */
let shotOverlayState = { phase: 'idle', shot: null, screens: [], windows: [], virtual: null, error: null, captureSeq: 0 }
const shotOverlayListeners = new Set()

function shotSetOverlay(patch) {
  shotOverlayState = { ...shotOverlayState, ...patch }
  for (const listener of shotOverlayListeners) {
    try {
      listener()
    } catch (error) {
      /* ignore */
    }
  }
}

function shotSubscribeOverlay(listener) {
  shotOverlayListeners.add(listener)
  return function unsubscribe() {
    shotOverlayListeners.delete(listener)
  }
}

function shotUseOverlay() {
  return React.useSyncExternalStore(shotSubscribeOverlay, function read() {
    return shotOverlayState
  }, function readServer() {
    return shotOverlayState
  })
}

/* -------------------------------------------------------------------------- */
/* overlay window: temporarily maximize the DSH window while selecting       */
/* -------------------------------------------------------------------------- */

/**
 * The overlay is rendered inside the DSH app window, so a shrunk window makes
 * whole-desktop framing awkward. The host maximizes the window for the overlay
 * session and restores the exact previous placement when it closes.
 */
let shotOverlayWindowPrepared = false

async function shotPrepareOverlayWindow() {
  try {
    const payload = await shotHostJson('/overlay-window', { action: 'prepare' }, 5000)
    shotOverlayWindowPrepared = true
    return payload
  } catch (error) {
    // Older hosts do not expose this route; capture still works in-place.
    shotOverlayWindowPrepared = false
    return null
  }
}

function shotRestoreOverlayWindow() {
  if (!shotOverlayWindowPrepared) return
  shotOverlayWindowPrepared = false
  shotHostJson('/overlay-window', { action: 'restore' }, 8000).catch(function ignoreRestoreFailure() {
    /* restoring the window is cosmetic; never surface an error toast for it */
  })
}

/** Trigger one capture; ignored while a capture/overlay is already running. */
async function shotStartCapture(t) {
  if (shotOverlayState.phase === 'capturing' || shotOverlayState.phase === 'ready') return
  shotSetOverlay({ phase: 'capturing', shot: null, screens: [], windows: [], virtual: null, error: null, captureSeq: shotOverlayState.captureSeq + 1 })
  try {
    const payload = await shotHostJson('/capture', {}, 30000)
    await shotPrepareOverlayWindow()
    shotSetOverlay({
      phase: 'ready',
      shot: payload.image,
      screens: Array.isArray(payload.screens) ? payload.screens : [],
      windows: Array.isArray(payload.windows) ? payload.windows : [],
      virtual: payload.virtual !== null && typeof payload.virtual === 'object' ? payload.virtual : null,
      error: null,
    })
  } catch (error) {
    shotSetOverlay({ phase: 'idle', shot: null, screens: [], windows: [], virtual: null, error: null })
    shotPushToast({
      kind: 'error',
      text: tShot('captureFailed', { message: error.message }),
      duration: 6000,
    })
  }
}

function shotCloseOverlay() {
  shotSetOverlay({ phase: 'idle', shot: null, screens: [], windows: [], virtual: null, error: null, captureSeq: shotOverlayState.captureSeq + 1 })
  shotRestoreOverlayWindow()
}

/* -------------------------------------------------------------------------- */
/* global-hotkey store + capture event stream (host phase B, optional)        */
/* -------------------------------------------------------------------------- */

/**
 * supported: the Host exposes the global-hotkey contract (task-3 build);
 * enabled:   the user preference sent to the Host;
 * registered: the OS registration actually succeeded;
 * error:     Host-reported registration failure, if any.
 */
let shotGlobalState = {
  phase: 'unknown',
  supported: false,
  enabled: false,
  registered: false,
  error: null,
}
const shotGlobalListeners = new Set()

function shotSetGlobal(patch) {
  shotGlobalState = { ...shotGlobalState, ...patch }
  for (const listener of shotGlobalListeners) {
    try {
      listener()
    } catch (error) {
      /* ignore */
    }
  }
}

function shotSubscribeGlobal(listener) {
  shotGlobalListeners.add(listener)
  return function unsubscribe() {
    shotGlobalListeners.delete(listener)
  }
}

function shotUseGlobal() {
  return React.useSyncExternalStore(shotSubscribeGlobal, function read() {
    return shotGlobalState
  }, function readServer() {
    return shotGlobalState
  })
}

/** The in-app listener steps aside while an OS-global hotkey handles the chord. */
function shotGlobalHotkeyActive() {
  return shotGlobalState.supported && shotGlobalState.registered
}

function shotApplyGlobalStatus(globalHotkey) {
  if (globalHotkey === null || typeof globalHotkey !== 'object') return
  shotSetGlobal({
    phase: 'ready',
    supported: true,
    enabled: globalHotkey.enabled === true,
    registered: globalHotkey.registered === true,
    error: typeof globalHotkey.error === 'string' && globalHotkey.error.length > 0 ? globalHotkey.error : null,
  })
}

/** Read /status once; enables the SSE subscription only when phase B is present. */
async function shotRefreshGlobalStatus() {
  try {
    const status = await shotHostJson('/status', undefined, 10000)
    if (status.globalHotkey === undefined) {
      shotSetGlobal({ phase: 'unsupported', supported: false, enabled: false, registered: false, error: null })
      return false
    }
    shotApplyGlobalStatus(status.globalHotkey)
    return true
  } catch (error) {
    shotSetGlobal({ phase: 'unavailable', supported: false, error: error.message })
    return false
  }
}

/** Persist the preference on the host and (re)register the OS hotkey. */
async function shotApplyGlobalConfig(enabled, shortcut) {
  shotSetGlobal({ phase: 'applying', error: null })
  try {
    const payload = await shotHostJson('/config', { enabled, shortcut }, 10000)
    shotApplyGlobalStatus(payload.globalHotkey)
    return true
  } catch (error) {
    if (error.code === 'http' || error.code === 'network' || error.code === 'timeout') {
      shotSetGlobal({ phase: 'unsupported', supported: false, error: error.message })
    } else {
      shotSetGlobal({ phase: 'ready', error: error.message })
    }
    return false
  }
}

/* ---- capture event stream (Server-Sent Events) -------------------------- */

let shotEventsSource = null
let shotEventReconnectTimer = null
let shotEventsDisposed = false
let shotEventsOpenedOnce = false
let shotLastHandledSeq = 0
const SHOT_EVENT_RECONNECT_MS = 2500
/** A capture is still worth surfacing if it happened within this window. */
const SHOT_CATCH_UP_WINDOW_MS = 15000

async function shotLoadLastCapture(t) {
  if (shotOverlayState.phase !== 'idle') return
  shotSetOverlay({ phase: 'capturing', shot: null, screens: [], windows: [], virtual: null, error: null, captureSeq: shotOverlayState.captureSeq + 1 })
  try {
    const payload = await shotHostJson('/last-capture', undefined, 15000)
    await shotPrepareOverlayWindow()
    shotSetOverlay({
      phase: 'ready',
      shot: payload.image,
      screens: Array.isArray(payload.screens) ? payload.screens : [],
      windows: Array.isArray(payload.windows) ? payload.windows : [],
      virtual: payload.virtual !== null && typeof payload.virtual === 'object' ? payload.virtual : null,
      error: null,
    })
  } catch (error) {
    shotSetOverlay({ phase: 'idle', shot: null, screens: [], windows: [], virtual: null, error: null })
    shotPushToast({ kind: 'error', text: tShot('captureFailed', { message: error.message }), duration: 6000 })
  }
}

/**
 * A capture pressed while the event stream was reconnecting (host plugin
 * reload/restart) arrives before the new SSE connection exists. On every
 * re-connect, recover a recent unhandled capture from `/last-capture`; older
 * captures are marked as handled without opening a stale overlay.
 */
async function shotCatchUpLastCapture(t) {
  if (shotOverlayState.phase !== 'idle') return
  try {
    const payload = await shotHostJson('/last-capture', undefined, 8000)
    if (typeof payload.seq !== 'number' || payload.seq <= shotLastHandledSeq) return
    const capturedAt = Date.parse(payload.capturedAt)
    const fresh = !Number.isFinite(capturedAt) || (Date.now() - capturedAt) <= SHOT_CATCH_UP_WINDOW_MS
    shotLastHandledSeq = payload.seq
    if (!fresh) return
    await shotPrepareOverlayWindow()
    shotSetOverlay({
      phase: 'ready',
      shot: payload.image,
      screens: Array.isArray(payload.screens) ? payload.screens : [],
      windows: Array.isArray(payload.windows) ? payload.windows : [],
      virtual: payload.virtual !== null && typeof payload.virtual === 'object' ? payload.virtual : null,
      error: null,
    })
  } catch (error) {
    /* 404 no-capture / transient host errors are expected during reconnects */
  }
}

function shotConnectEvents(t) {
  shotEventsDisposed = false
  if (shotEventsSource !== null) return
  if (typeof EventSource !== 'function') return
  let source
  try {
    source = new EventSource(SHOT_API + '/events')
  } catch (error) {
    return
  }
  shotEventsSource = source

  const scheduleReconnect = function scheduleReconnect() {
    if (shotEventsDisposed || shotEventReconnectTimer !== null) return
    shotEventReconnectTimer = window.setTimeout(function reconnectNow() {
      shotEventReconnectTimer = null
      if (shotEventsDisposed) return
      shotConnectEvents(t)
    }, SHOT_EVENT_RECONNECT_MS)
  }

  source.onopen = function onOpen() {
    if (shotEventsOpenedOnce) void shotCatchUpLastCapture(t)
    shotEventsOpenedOnce = true
  }
  source.addEventListener('capture', function onCapture(event) {
    let seq = 0
    try {
      const payload = JSON.parse(event.data)
      if (payload !== null && typeof payload.seq === 'number') seq = payload.seq
    } catch (error) {
      /* fall through and consume the cached capture */
    }
    if (seq > 0) {
      if (seq <= shotLastHandledSeq) return
      shotLastHandledSeq = seq
    }
    void shotLoadLastCapture(t)
  })
  source.addEventListener('capture-failed', function onCaptureFailed(event) {
    let message = tShot('captureFailedGeneric')
    try {
      const payload = JSON.parse(event.data)
      if (payload !== null && typeof payload.message === 'string') message = payload.message
    } catch (error) {
      /* keep the generic message */
    }
    shotPushToast({ kind: 'error', text: tShot('captureFailed', { message }), duration: 6000 })
  })
  source.onerror = function onError() {
    if (shotEventsSource !== source) return
    // EventSource only auto-reconnects on transport failures. A host-plugin
    // reload removes the route, which the browser turns into a permanent
    // CLOSED state (non-event-stream response); retry it ourselves so a
    // disabled/enabled or restarted Host comes back without a page reload.
    if (source.readyState === 2) {
      try {
        source.close()
      } catch (error) {
        /* ignore */
      }
      if (shotEventsSource === source) shotEventsSource = null
      scheduleReconnect()
    }
  }
}

function shotDisconnectEvents() {
  shotEventsDisposed = true
  if (shotEventReconnectTimer !== null) {
    window.clearTimeout(shotEventReconnectTimer)
    shotEventReconnectTimer = null
  }
  if (shotEventsSource !== null) {
    try {
      shotEventsSource.close()
    } catch (error) {
      /* ignore */
    }
    shotEventsSource = null
  }
}

/* -------------------------------------------------------------------------- */
/* toast store                                                                */
/* -------------------------------------------------------------------------- */

let shotToastSeq = 0
let shotToastList = []
const shotToastListeners = new Set()
const shotToastTimers = new Map()

function shotNotifyToasts() {
  for (const listener of shotToastListeners) {
    try {
      listener()
    } catch (error) {
      /* ignore */
    }
  }
}

function shotPushToast(toast) {
  const id = ++shotToastSeq
  const entry = {
    id,
    kind: toast.kind === 'error' ? 'error' : toast.kind === 'success' ? 'success' : 'info',
    text: typeof toast.text === 'string' ? toast.text : '',
    action: toast.action !== undefined ? toast.action : null,
    duration: typeof toast.duration === 'number' ? toast.duration : 3600,
  }
  shotToastList = shotToastList.concat([entry])
  shotNotifyToasts()
  const timer = window.setTimeout(function expireToast() {
    shotDismissToast(id)
  }, entry.duration)
  shotToastTimers.set(id, timer)
  return id
}

function shotDismissToast(id) {
  const timer = shotToastTimers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    shotToastTimers.delete(id)
  }
  const next = shotToastList.filter(function keep(item) { return item.id !== id })
  if (next.length === shotToastList.length) return
  shotToastList = next
  shotNotifyToasts()
}

function shotSubscribeToasts(listener) {
  shotToastListeners.add(listener)
  return function unsubscribe() {
    shotToastListeners.delete(listener)
  }
}

function shotUseToasts() {
  return React.useSyncExternalStore(shotSubscribeToasts, function read() {
    return shotToastList
  }, function readServer() {
    return shotToastList
  })
}

/* -------------------------------------------------------------------------- */
/* shortcut recorder bridge (settings page <-> global keydown listener)       */
/* -------------------------------------------------------------------------- */

const shotRecorder = { active: false, handler: null }

function shotSetRecorder(handler) {
  if (typeof handler === 'function') {
    shotRecorder.active = true
    shotRecorder.handler = handler
  } else {
    shotRecorder.active = false
    shotRecorder.handler = null
  }
}

/* -------------------------------------------------------------------------- */
/* locale binding: tShot reads the locale of the caller-supplied translate fn */
/* -------------------------------------------------------------------------- */

let shotTranslate = null

/**
 * Bind the shared translate function during apply(). Components receive it
 * through props in practice; this fallback keeps store-level messages (capture
 * failures, toasts) localized.
 */
function shotBindTranslate(translate) {
  shotTranslate = typeof translate === 'function' ? translate : null
}

function tShot(key, params) {
  if (shotTranslate !== null) {
    try {
      return shotTranslate(key, params)
    } catch (error) {
      /* fall through to key */
    }
  }
  return key
}

/** React hook: re-render on locale changes. */
function shotUseLocaleRevision(ctx) {
  return React.useSyncExternalStore(
    function subscribe(listener) { return ctx.locale.subscribe(listener) },
    function snapshot() { return ctx.locale.getSnapshot().revision },
    function server() { return 0 },
  )
}

/* -------------------------------------------------------------------------- */
/* stylesheet injection                                                       */
/* -------------------------------------------------------------------------- */

const SHOT_STYLE_ID = 'dsh-screencapture/client.css'

function shotInjectStyles(css) {
  if (typeof document === 'undefined') return function noop() {}
  const existing = document.querySelector('style[data-plugin-css="' + SHOT_STYLE_ID + '"]')
  if (existing !== null) existing.remove()
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-screencapture'
  tag.dataset.pluginCss = SHOT_STYLE_ID
  tag.textContent = css
  document.head.appendChild(tag)
  return function removeStyles() {
    tag.remove()
  }
}

/* -------------------------------------------------------------------------- */
/* icons (16px stroke icons, drawn inline so the bundle has no asset traffic) */
/* -------------------------------------------------------------------------- */

function shotIcon(paths, options) {
  const opts = options || {}
  return function ShotIcon(props) {
    const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
    return h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: opts.fill === true ? 'currentColor' : 'none',
        stroke: opts.fill === true ? 'none' : 'currentColor',
        strokeWidth: opts.strokeWidth !== undefined ? opts.strokeWidth : 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
      paths.map(function renderPath(d, index) {
        return h('path', { key: String(index), d })
      }),
    )
  }
}

const ShotIconCamera = shotIcon([
  'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1-1.6h6.6l1 1.6h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z',
  'M9 12.6a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
])
const ShotIconRect = shotIcon(['M4 6h16v12H4z'])
const ShotIconEllipse = shotIcon(['M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z'])
const ShotIconArrow = shotIcon(['M5 19 19 5', 'M10 5h9v9'])
const ShotIconPen = shotIcon(['M4 20l4.5-1.2L20 7.3a2.1 2.1 0 0 0-3-3L5.5 15.8z'])
const ShotIconText = shotIcon(['M5 6h14', 'M12 6v13', 'M9 19h6'])
const ShotIconUndo = shotIcon(['M9 7 4 12l5 5', 'M4 12h9a7 7 0 0 1 7 7'])
const ShotIconRedo = shotIcon(['M15 7l5 5-5 5', 'M20 12h-9a7 7 0 0 0-7 7'])
const ShotIconDownload = shotIcon(['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19h14'])
const ShotIconCheck = shotIcon(['M4.5 12.5 10 18 19.5 6.5'])
const ShotIconClose = shotIcon(['M6 6l12 12', 'M18 6 6 18'])
const ShotIconCopy = shotIcon(['M9 9h9v11H9z', 'M6 15H4V4h11v2'])
const ShotIconFolder = shotIcon(['M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.6 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5z'])
const ShotIconReset = shotIcon(['M4 5v5h5', 'M4.6 10a8 8 0 1 1 .4 6.4'])
const ShotIconCursor = shotIcon(['M5 3l6 17 2.2-6.8L20 11z'])

function ShotSpinner(props) {
  const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 22
  return h(
    'svg',
    {
      className: 'dsh-shot-spin',
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2.2,
      strokeLinecap: 'round',
      'aria-hidden': true,
    },
    [h('path', { key: 'arc', d: 'M12 3a9 9 0 1 0 9 9' })],
  )
}

/* -------------------------------------------------------------------------- */
/* small shared UI primitives                                                 */
/* -------------------------------------------------------------------------- */

function ShotIconButton(props) {
  const label = typeof props.label === 'string' ? props.label : ''
  return h(
    'button',
    {
      type: 'button',
      className: shotClassNames('dsh-shot-iconbtn', props.active === true && 'dsh-shot-iconbtn--active', props.className),
      title: label,
      'aria-label': label,
      'aria-pressed': props.pressed === true ? 'true' : undefined,
      disabled: props.disabled === true,
      onMouseDown: props.onMouseDown,
      onClick: props.onClick,
    },
    h(props.icon, { size: props.size !== undefined ? props.size : 17 }),
  )
}

function ShotSwitch(props) {
  const checked = props.checked === true
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': props.label,
      className: shotClassNames('dsh-shot-switch', checked && 'dsh-shot-switch--on'),
      disabled: props.disabled === true,
      onClick: function onClick() {
        if (props.disabled !== true) props.onChange(!checked)
      },
    },
    h('span', { className: 'dsh-shot-switch__thumb' }),
  )
}
