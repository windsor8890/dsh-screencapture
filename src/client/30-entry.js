/* ============================================================================
 * dsh-screencapture client :: plugin entry
 * Locale dictionaries, the three slot registrations (settings page, composer
 * trigger, frame overlay) and the configurable in-app shortcut listener.
 * ========================================================================== */

/** Simplified Chinese copy (key-set source of truth). */
const SHOT_LOCALE_ZH = {
  title: '截图',
  intro: '仿微信的截图工具：按下快捷键后框选屏幕区域，标注后复制到剪贴板或保存为图片。',
  triggerTooltip: '截图（{shortcut}）',
  triggerAria: '截图',
  captureFailed: '截图失败：{message}',
  captureFailedGeneric: '截图失败',
  timeoutError: '请求超时',
  networkError: '网络错误',
  renderFailed: '无法生成截图画面',
  shortcutUnsupportedKey: '该按键无法注册为全局快捷键，请换一个组合。',
  capturing: '正在截图…',
  decoding: '正在准备截图…',
  decodeFailed: '截图数据无法解码',
  hint: '拖拽框选 · 悬停窗口点击截取整窗 · 拖动选区可移动 · Esc 取消',
  toolRect: '矩形',
  toolEllipse: '椭圆',
  toolArrow: '箭头',
  toolPen: '画笔',
  toolText: '文字',
  undo: '撤销 (Ctrl+Z)',
  redo: '重做 (Ctrl+Shift+Z)',
  cancel: '取消 (Esc)',
  save: '保存图片 (Ctrl+S)',
  copy: '复制',
  textPlaceholder: '输入文字',
  copied: '已复制到剪贴板',
  copiedAndSaved: '已复制，并保存到 {path}',
  copyFailed: '复制失败：{message}',
  saved: '已保存到 {path}',
  saveFailed: '保存失败：{message}',
  openFolder: '打开文件夹',
  dismiss: '关闭提示',
  shortcutTitle: '截图快捷键',
  shortcutDescription: '在 DSH 窗口聚焦时按下此组合键即可开始截图。若组合键被 DSH 或其它软件占用，可能无法触发。',
  globalTitle: '全局快捷键',
  globalDescription: '注册为系统级快捷键：焦点在其他窗口时也能直接唤起截图（可能与其它软件冲突）。',
  globalChecking: '正在检查全局快捷键支持…',
  globalUnsupported: '当前 Host 版本不支持全局快捷键，仅窗口聚焦时可用。',
  globalApplying: '正在注册全局快捷键…',
  globalRegistered: '已注册系统级快捷键，焦点不在 DSH 时也可截图。',
  globalPending: '已开启，等待注册…',
  globalFailed: '全局快捷键注册失败：{message}',
  change: '修改',
  resetDefault: '恢复默认',
  recording: '请按下新的快捷键…',
  recordingCancel: '取消',
  shortcutNeedsModifier: '快捷键需要包含 Ctrl、Alt 或 Meta 修饰键。',
  autoSaveTitle: '复制时同时保存图片',
  autoSaveDescription: '关闭时只复制到剪贴板，不写入文件。',
  directoryTitle: '保存位置',
  directoryDescription: '留空时保存到 图片\\DSH Screenshots；也可以填写任意绝对路径。',
  saveDirectoryPlaceholder: '默认：图片\\DSH Screenshots',
  useDefault: '使用默认',
  testTitle: '测试截图',
  testDescription: '立即打开截图浮层，验证截图引擎是否可用。',
  testButton: '立即截图',
  testing: '截图中…',
  statusLoading: '正在检测截图引擎…',
  statusReady: '截图引擎已就绪',
  statusIdle: '截图引擎待启动（首次截图时自动启动）',
  statusError: '不可用：{message}',
  footerHint: '提示：输入框左侧也有截图按钮；快捷键仅在 DSH 窗口聚焦时生效。',
}

/** English copy (same key set as the Chinese dictionary). */
const SHOT_LOCALE_EN = {
  title: 'Screenshot',
  intro: 'A WeChat-style screenshot tool: press the shortcut, drag a region, annotate it, then copy it to the clipboard or save it as an image.',
  triggerTooltip: 'Screenshot ({shortcut})',
  triggerAria: 'Screenshot',
  captureFailed: 'Screenshot failed: {message}',
  captureFailedGeneric: 'Screenshot failed',
  timeoutError: 'The request timed out',
  networkError: 'Network error',
  renderFailed: 'Could not render the capture',
  shortcutUnsupportedKey: 'That key cannot be registered as a global shortcut; choose another chord.',
  capturing: 'Capturing…',
  decoding: 'Preparing screenshot…',
  decodeFailed: 'The captured image could not be decoded',
  hint: 'Drag to select · hover a window and click to capture it · drag the selection to move it · Esc to cancel',
  toolRect: 'Rectangle',
  toolEllipse: 'Ellipse',
  toolArrow: 'Arrow',
  toolPen: 'Pen',
  toolText: 'Text',
  undo: 'Undo (Ctrl+Z)',
  redo: 'Redo (Ctrl+Shift+Z)',
  cancel: 'Cancel (Esc)',
  save: 'Save image (Ctrl+S)',
  copy: 'Copy',
  textPlaceholder: 'Type text',
  copied: 'Copied to clipboard',
  copiedAndSaved: 'Copied and saved to {path}',
  copyFailed: 'Copy failed: {message}',
  saved: 'Saved to {path}',
  saveFailed: 'Save failed: {message}',
  openFolder: 'Open folder',
  dismiss: 'Dismiss',
  shortcutTitle: 'Screenshot shortcut',
  shortcutDescription: 'Press this chord while the DSH window is focused to start a capture. A chord already owned by DSH or another app may never reach the plugin.',
  globalTitle: 'Global shortcut',
  globalDescription: 'Register an OS-level hotkey so a capture works even when another window is focused (may conflict with other apps).',
  globalChecking: 'Checking global-shortcut support…',
  globalUnsupported: 'This Host build does not support a global shortcut; the shortcut only works while the window is focused.',
  globalApplying: 'Registering the global shortcut…',
  globalRegistered: 'Global shortcut registered; captures work while another window is focused.',
  globalPending: 'Enabled, waiting for registration…',
  globalFailed: 'Global shortcut registration failed: {message}',
  change: 'Change',
  resetDefault: 'Reset',
  recording: 'Press the new shortcut…',
  recordingCancel: 'Cancel',
  shortcutNeedsModifier: 'A shortcut must include the Ctrl, Alt or Meta modifier.',
  autoSaveTitle: 'Also save the image on copy',
  autoSaveDescription: 'When off, only the clipboard is filled.',
  directoryTitle: 'Save location',
  directoryDescription: 'Leave empty to save into Pictures\\DSH Screenshots; any absolute path works.',
  saveDirectoryPlaceholder: 'Default: Pictures\\DSH Screenshots',
  useDefault: 'Use default',
  testTitle: 'Test capture',
  testDescription: 'Open the capture surface now to confirm the native engine works.',
  testButton: 'Capture now',
  testing: 'Capturing…',
  statusLoading: 'Checking the capture engine…',
  statusReady: 'Capture engine ready',
  statusIdle: 'Capture engine idle (starts on first capture)',
  statusError: 'Unavailable: {message}',
  footerHint: 'Tip: the composer also has a screenshot button; the shortcut works while the DSH window is focused.',
}

/* -------------------------------------------------------------------------- */
/* composer trigger                                                           */
/* -------------------------------------------------------------------------- */

const ShotIconShot = shotIcon([
  'M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9',
  'M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9',
  'M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15',
  'M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15',
  'M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0',
])

function ShotTriggerButton(props) {
  const t = props.t
  shotUseLocaleRevision(props.ctx)
  const settings = shotUseSettings()
  const shortcut = shotFormatChord(settings.shortcut)
  const tooltip = function tooltipText() {
    try {
      return t('triggerTooltip', { shortcut })
    } catch (error) {
      return shortcut
    }
  }()
  const busy = shotOverlayState.phase !== 'idle'
  return h('button', {
    type: 'button',
    className: 'dsh-shot-trigger',
    title: tooltip,
    'aria-label': t('triggerAria'),
    disabled: busy,
    onMouseDown: function keepFocus(event) { event.preventDefault() },
    onClick: function onClick() {
      void shotStartCapture(t)
    },
  }, h(ShotIconShot, { size: 16 }))
}

/* -------------------------------------------------------------------------- */
/* plugin wiring                                                              */
/* -------------------------------------------------------------------------- */

/** Client services this plugin needs. */
const inject = ['slots', 'locale']

function apply(ctx) {
  ctx.effect(function registerLocale() {
    return ctx.locale.register(SHOT_LOCALE_NS, { zh: SHOT_LOCALE_ZH, en: SHOT_LOCALE_EN })
  }, 'dsh-screencapture: locale dictionaries')

  const boundTranslate = (function bindLocaleOnce() {
    try {
      return ctx.locale.bind(SHOT_LOCALE_NS)
    } catch (error) {
      return null
    }
  })()
  const translate = function translate(key, params) {
    try {
      if (boundTranslate !== null) return boundTranslate(key, params)
      return ctx.locale.bind(SHOT_LOCALE_NS)(key, params)
    } catch (error) {
      if (params !== null && typeof params === 'object' && typeof params.message === 'string') {
        return key + ': ' + params.message
      }
      return key
    }
  }
  shotBindTranslate(translate)

  ctx.effect(function injectStyles() {
    return shotInjectStyles([SHOT_OVERLAY_CSS, SHOT_SETTINGS_CSS, SHOT_TRIGGER_CSS].join('\n'))
  }, 'dsh-screencapture: styles')

  ctx.effect(function listenShortcut() {
    const onKeyDown = function onKeyDown(event) {
      if (shotRecorder.active && typeof shotRecorder.handler === 'function') {
        shotRecorder.handler(event)
        return
      }
      if (shotGlobalHotkeyActive()) return
      if (shotOverlayState.phase !== 'idle') return
      const settings = shotReadSettings()
      if (!shotEventMatchesChord(event, settings.shortcut)) return
      event.preventDefault()
      event.stopPropagation()
      void shotStartCapture(translate)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return function cleanup() {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, 'dsh-screencapture: shortcut listener')

  ctx.effect(function connectGlobalHotkey() {
    let disposed = false
    ;(async function bootstrap() {
      const supported = await shotRefreshGlobalStatus()
      if (disposed || !supported) return
      const settings = shotReadSettings()
      shotConnectEvents(translate)
      await shotApplyGlobalConfig(settings.globalHotkey, settings.shortcut)
    })()
    return function cleanup() {
      disposed = true
      shotDisconnectEvents()
    }
  }, 'dsh-screencapture: global hotkey + capture events')

  ctx.slots.inject('conversation.input.left', function injectTrigger() {
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'dsh-screencapture-trigger',
      order: 6,
    }, function TriggerSeat(props) {
      return h(ShotTriggerButton, { ...props, t: translate, ctx })
    })
  })

  ctx.slots.inject('shell.overlay', function injectOverlay() {
    return ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-screencapture-overlay',
      order: 60,
    }, function OverlaySeat() {
      return h(ShotOverlayRoot, { t: translate })
    })
  })

  ctx.slots.inject('settings.section', function injectSettings() {
    return ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-screencapture',
      order: 26,
      label: function label() { return translate('title') },
    }, function SettingsSeat(props) {
      return h(ShotSettingsPage, { ...props, t: translate, ctx })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* trigger styles                                                             */
/* -------------------------------------------------------------------------- */

const SHOT_TRIGGER_CSS = [
  '.dsh-shot-trigger{width:28px;height:28px;border-radius:999px;border:none;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);cursor:pointer;display:grid;place-items:center;flex:none;padding:0}',
  '.dsh-shot-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
  '.dsh-shot-trigger:active:not(:disabled){transform:scale(.96)}',
  '.dsh-shot-trigger:disabled{opacity:.45;cursor:default}',
].join('\n')
