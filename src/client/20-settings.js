/* ============================================================================
 * dsh-screencapture client :: settings page
 * One first-level Settings section ("截图") with the shortcut recorder, the
 * auto-save switch, the save-directory field and a capture self-test.
 * ========================================================================== */

function ShotSettingsPage(props) {
  const t = props.t
  const ctx = props.ctx
  shotUseLocaleRevision(ctx)
  const settings = shotUseSettings()
  const globalState = shotUseGlobal()
  const [recording, setRecording] = React.useState(false)
  const [recordError, setRecordError] = React.useState('')
  const [directoryDraft, setDirectoryDraft] = React.useState(settings.saveDirectory)
  const [testing, setTesting] = React.useState(false)
  const [hostStatus, setHostStatus] = React.useState({ state: 'loading', text: '' })
  const directoryDirty = React.useRef(false)

  React.useEffect(function syncDirectoryDraft() {
    if (!directoryDirty.current) setDirectoryDraft(settings.saveDirectory)
  }, [settings.saveDirectory])

  /* ---- host status (shows whether the native capture half is reachable) -- */

  React.useEffect(function probeHost() {
    let cancelled = false
    shotHostJson('/status', undefined, 8000).then(function onOk(status) {
      if (cancelled) return
      const ready = status.helper === 'ready'
      setHostStatus({
        state: ready ? 'ready' : 'idle',
        text: ready ? t('statusReady') : t('statusIdle'),
        screens: Array.isArray(status.screens) ? status.screens.length : 0,
      })
    }).catch(function onError(error) {
      if (cancelled) return
      setHostStatus({ state: 'error', text: t('statusError', { message: error.message }) })
    })
    return function cleanup() {
      cancelled = true
    }
  }, [])

  React.useEffect(function refreshGlobalHotkeyStatus() {
    let cancelled = false
    ;(async function run() {
      await shotRefreshGlobalStatus()
      if (cancelled) return
    })()
    return function cleanup() {
      cancelled = true
    }
  }, [])

  /* ---- shortcut recorder ------------------------------------------------- */

  function stopRecording() {
    setRecording(false)
    setRecordError('')
    shotSetRecorder(null)
  }

  function startRecording() {
    setRecordError('')
    setRecording(true)
  }

  React.useEffect(function wireRecorder() {
    if (!recording) return undefined
    const handler = function recorderKeydown(event) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        stopRecording()
        return
      }
      const chord = shotChordFromEvent(event)
      if (chord === null) return
      if (!shotIsHostSupportedCode(chord.code)) {
        setRecordError(t('shortcutUnsupportedKey'))
        return
      }
      if (!shotIsEligibleChord(chord)) {
        setRecordError(t('shortcutNeedsModifier'))
        return
      }
      shotWriteSettings({ shortcut: chord })
      if (shotReadSettings().globalHotkey) void shotApplyGlobalConfig(true, chord)
      stopRecording()
    }
    shotSetRecorder(handler)
    return function cleanup() {
      shotSetRecorder(null)
    }
  }, [recording, t])

  /* ---- directory field --------------------------------------------------- */

  function commitDirectory() {
    shotWriteSettings({ saveDirectory: directoryDraft.trim() })
    directoryDirty.current = false
  }

  /* ---- capture self-test ------------------------------------------------- */

  async function runSelfTest() {
    if (testing) return
    setTesting(true)
    try {
      await shotStartCapture(t)
    } finally {
      setTesting(false)
    }
  }

  /* ---- render helpers ---------------------------------------------------- */

  function row(title, description, control, extra) {
    return h('div', { className: 'dsh-shot-settings-row' },
      h('div', { className: 'dsh-shot-settings-row__text' },
        h('div', { className: 'dsh-shot-settings-row__title' }, title),
        description !== null ? h('div', { className: 'dsh-shot-settings-row__description' }, description) : null,
        extra !== undefined ? extra : null,
      ),
      h('div', { className: 'dsh-shot-settings-row__control' }, control),
    )
  }

  const shortcutControl = recording
    ? h('div', { className: 'dsh-shot-recorder' },
      h('span', { className: 'dsh-shot-recorder__pulse' }),
      h('span', { className: 'dsh-shot-recorder__text' }, t('recording')),
      h('button', {
        type: 'button',
        className: 'dsh-shot-btn dsh-shot-btn--ghost',
        onClick: stopRecording,
      }, t('recordingCancel')),
    )
    : h('div', { className: 'dsh-shot-shortcut' },
      h('span', { className: 'dsh-shot-kbd' }, shotFormatChord(settings.shortcut)),
      h('button', {
        type: 'button',
        className: 'dsh-shot-btn',
        onClick: startRecording,
      }, t('change')),
      h('button', {
        type: 'button',
        className: 'dsh-shot-btn dsh-shot-btn--ghost',
        disabled: shotChordsEqual(settings.shortcut, SHOT_DEFAULT_SETTINGS.shortcut),
        onClick: function resetShortcut() {
          shotWriteSettings({ shortcut: SHOT_DEFAULT_SETTINGS.shortcut })
        },
      }, t('resetDefault')),
    )

  const directoryControl = h('div', { className: 'dsh-shot-dir' },
    h('input', {
      type: 'text',
      className: 'dsh-shot-input',
      value: directoryDraft,
      placeholder: t('saveDirectoryPlaceholder'),
      spellCheck: false,
      onChange: function onChange(event) {
        directoryDirty.current = true
        setDirectoryDraft(event.target.value)
      },
      onBlur: commitDirectory,
      onKeyDown: function onKeyDown(event) {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitDirectory()
          event.currentTarget.blur()
        }
      },
    }),
    h('button', {
      type: 'button',
      className: 'dsh-shot-btn dsh-shot-btn--ghost',
      disabled: settings.saveDirectory.length === 0,
      onClick: function clearDirectory() {
        directoryDirty.current = false
        setDirectoryDraft('')
        shotWriteSettings({ saveDirectory: '' })
      },
    }, t('useDefault')),
  )

  const statusTone = hostStatus.state === 'error'
    ? 'dsh-shot-status dsh-shot-status--error'
    : hostStatus.state === 'ready'
      ? 'dsh-shot-status dsh-shot-status--ok'
      : 'dsh-shot-status'
  const statusText = hostStatus.state === 'loading'
    ? t('statusLoading')
    : hostStatus.text

  const globalStatusText = globalState.phase === 'unknown'
    ? t('globalChecking')
    : !globalState.supported
      ? t('globalUnsupported')
      : globalState.phase === 'applying'
        ? t('globalApplying')
        : globalState.registered
          ? t('globalRegistered')
          : globalState.error !== null
            ? t('globalFailed', { message: globalState.error })
            : t('globalPending')
  const globalTone = globalState.registered
    ? 'dsh-shot-status dsh-shot-status--ok'
    : globalState.error !== null
      ? 'dsh-shot-status dsh-shot-status--error'
      : 'dsh-shot-status'

  const globalControl = h('div', { className: 'dsh-shot-global' },
    h(ShotSwitch, {
      checked: settings.globalHotkey,
      label: t('globalTitle'),
      disabled: globalState.phase === 'unknown' || !globalState.supported,
      onChange: function onChange(next) {
        shotWriteSettings({ globalHotkey: next })
        void shotApplyGlobalConfig(next, shotReadSettings().shortcut)
      },
    }),
  )

  return h('div', { className: 'dsh-shot-settings' },
    h('h2', { className: 'dsh-shot-settings__title' }, t('title')),
    h('p', { className: 'dsh-shot-settings__intro' }, t('intro')),
    h('div', { className: 'dsh-shot-settings__rows' },
      row(t('shortcutTitle'), t('shortcutDescription'), shortcutControl,
        recordError.length > 0
          ? h('div', { className: 'dsh-shot-settings-error', role: 'alert' }, recordError)
          : null),
      row(t('globalTitle'), t('globalDescription'), globalControl,
        h('div', { className: globalTone, role: 'status' }, globalStatusText)),
      row(t('autoSaveTitle'), t('autoSaveDescription'),
        h(ShotSwitch, {
          checked: settings.autoSave,
          label: t('autoSaveTitle'),
          onChange: function onChange(next) {
            shotWriteSettings({ autoSave: next })
          },
        })),
      row(t('directoryTitle'), t('directoryDescription'), directoryControl),
      row(t('testTitle'), t('testDescription'),
        h('div', { className: 'dsh-shot-test' },
          h('button', {
            type: 'button',
            className: 'dsh-shot-btn',
            disabled: testing || shotOverlayState.phase !== 'idle',
            onClick: runSelfTest,
          }, testing ? t('testing') : t('testButton')),
          h('span', { className: statusTone }, statusText),
        )),
    ),
    h('div', { className: 'dsh-shot-settings__footer' },
      h('span', { className: 'dsh-shot-settings__hint' }, t('footerHint')),
      h('span', { className: 'dsh-shot-settings__version' }, 'v1.0.0'),
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* styles                                                                     */
/* -------------------------------------------------------------------------- */

const SHOT_SETTINGS_CSS = [
  '.dsh-shot-settings{display:flex;flex-direction:column;width:100%;min-width:0}',
  '.dsh-shot-settings__title{margin:0 0 6px;color:var(--dsw-alias-label-primary);font-size:17px;font-weight:600;line-height:1.4}',
  '.dsh-shot-settings__intro{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:19px}',
  '.dsh-shot-settings__rows{display:flex;flex-direction:column}',
  '.dsh-shot-settings-row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
  '.dsh-shot-settings-row:last-child{border-bottom:none}',
  '.dsh-shot-settings-row__text{flex:1;min-width:0}',
  '.dsh-shot-settings-row__title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}',
  '.dsh-shot-settings-row__description{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
  '.dsh-shot-settings-row__control{flex:none;display:flex;align-items:center;gap:8px}',
  '.dsh-shot-shortcut{display:flex;align-items:center;gap:8px}',
  '.dsh-shot-kbd{display:inline-flex;align-items:center;padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.dsh-shot-btn{height:29px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1;cursor:pointer;white-space:nowrap}',
  '.dsh-shot-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
  '.dsh-shot-btn:disabled{opacity:.45;cursor:default}',
  '.dsh-shot-btn--ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}',
  '.dsh-shot-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
  '.dsh-shot-btn--primary{background:var(--dsw-alias-brand-primary,#2f86c9);border-color:transparent;color:#fff}',
  '.dsh-shot-recorder{display:flex;align-items:center;gap:8px}',
  '.dsh-shot-recorder__pulse{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#e5484d);animation:dsh-shot-pulse 1.1s ease-in-out infinite}',
  '.dsh-shot-recorder__text{color:var(--dsw-alias-label-primary);font-size:12.5px;white-space:nowrap}',
  '.dsh-shot-recording-cancel{height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
  '.dsh-shot-settings-error{margin-top:6px;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:18px}',
  '.dsh-shot-dir{display:flex;align-items:center;gap:6px}',
  '.dsh-shot-input{width:min(320px,32vw);height:29px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none}',
  '.dsh-shot-input:focus{border-color:var(--dsw-alias-brand-primary,#2f86c9)}',
  '.dsh-shot-input::placeholder{color:var(--dsw-alias-label-secondary)}',
  '.dsh-shot-test{display:flex;align-items:center;gap:10px}',
  '.dsh-shot-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-shot-status--ok{color:var(--dsw-alias-state-success-primary,#2f9e6e)}',
  '.dsh-shot-status--error{color:var(--dsw-alias-state-error-primary,#e5484d)}',
  '.dsh-shot-settings__footer{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:14px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
  '.dsh-shot-settings__version{font-variant-numeric:tabular-nums;opacity:.7}',
  '.dsh-shot-switch{position:relative;width:36px;height:20px;border-radius:999px;border:none;background:var(--dsw-alias-border-l2);cursor:pointer;padding:0;transition:background .15s ease}',
  '.dsh-shot-switch--on{background:var(--dsw-alias-brand-primary,#2f86c9)}',
  '.dsh-shot-switch__thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-label-primary,#fff);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}',
  '.dsh-shot-switch--on .dsh-shot-switch__thumb{transform:translateX(16px)}',
  '@keyframes dsh-shot-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
].join('\n')
