/* ============================================================================
 * dsh-screencapture client :: overlay editor
 * A WeChat-style frozen-screen capture surface: the whole desktop image is
 * displayed letterboxed in the app window, the user drags a region, annotates
 * it and copies/saves the result. Selection and annotations are stored in the
 * screenshot's natural pixel coordinates so the final crop re-renders at full
 * resolution; the canvas only ever works in display coordinates.
 * ========================================================================== */

const SHOT_COLORS = ['#ff3b30', '#ffd60a', '#0a84ff', '#ffffff']
const SHOT_TOOLS = ['rect', 'ellipse', 'arrow', 'pen', 'text']
/** Annotation stroke width in display pixels (converted to image px on create). */
const SHOT_STROKE_DISPLAY = 3
/** Text size in display pixels (converted to image px on create). */
const SHOT_FONT_DISPLAY = 18
/** Minimum selection size in image pixels. */
const SHOT_MIN_SELECTION = 6
const SHOT_HANDLE_HIT = 9

/* -------------------------------------------------------------------------- */
/* geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

function shotFitImage(shot, viewWidth, viewHeight) {  const imageWidth = Math.max(1, shot.width)
  const imageHeight = Math.max(1, shot.height)
  const scale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight)
  const displayWidth = imageWidth * scale
  const displayHeight = imageHeight * scale
  return {
    scale,
    imageWidth,
    imageHeight,
    displayWidth,
    displayHeight,
    offsetX: (viewWidth - displayWidth) / 2,
    offsetY: (viewHeight - displayHeight) / 2,
  }
}

function shotDisplayToImage(fit, x, y) {
  return {
    x: shotClamp((x - fit.offsetX) / fit.scale, 0, fit.imageWidth),
    y: shotClamp((y - fit.offsetY) / fit.scale, 0, fit.imageHeight),
  }
}

function shotImageToDisplay(fit, x, y) {
  return { x: fit.offsetX + x * fit.scale, y: fit.offsetY + y * fit.scale }
}

function shotImageRectToDisplay(fit, rect) {
  return {
    x: fit.offsetX + rect.x * fit.scale,
    y: fit.offsetY + rect.y * fit.scale,
    w: rect.w * fit.scale,
    h: rect.h * fit.scale,
  }
}

function shotRectFromPoints(a, b, imageWidth, imageHeight) {
  const left = shotClamp(Math.min(a.x, b.x), 0, imageWidth)
  const top = shotClamp(Math.min(a.y, b.y), 0, imageHeight)
  const right = shotClamp(Math.max(a.x, b.x), 0, imageWidth)
  const bottom = shotClamp(Math.max(a.y, b.y), 0, imageHeight)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function shotNormalizeSelection(selection, imageWidth, imageHeight) {
  const x = shotClamp(selection.x, 0, imageWidth)
  const y = shotClamp(selection.y, 0, imageHeight)
  const w = shotClamp(selection.w, 0, imageWidth - x)
  const h = shotClamp(selection.h, 0, imageHeight - y)
  return { x, y, w, h }
}

function shotHandlesOf(rect) {
  const midX = rect.x + rect.w / 2
  const midY = rect.y + rect.h / 2
  return [
    { name: 'nw', x: rect.x, y: rect.y },
    { name: 'n', x: midX, y: rect.y },
    { name: 'ne', x: rect.x + rect.w, y: rect.y },
    { name: 'e', x: rect.x + rect.w, y: midY },
    { name: 'se', x: rect.x + rect.w, y: rect.y + rect.h },
    { name: 's', x: midX, y: rect.y + rect.h },
    { name: 'sw', x: rect.x, y: rect.y + rect.h },
    { name: 'w', x: rect.x, y: midY },
  ]
}

function shotHitHandle(point, displayRect) {
  const handles = shotHandlesOf(displayRect)
  for (const handle of handles) {
    if (Math.abs(point.x - handle.x) <= SHOT_HANDLE_HIT && Math.abs(point.y - handle.y) <= SHOT_HANDLE_HIT) {
      return handle.name
    }
  }
  return null
}

const SHOT_HANDLE_CURSORS = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

function shotInsideDisplayRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
}

/** Topmost captured window (array is z-ordered) containing an image-space point. */
function shotWindowAtPoint(windowRects, point) {
  if (!Array.isArray(windowRects)) return null
  for (const win of windowRects) {
    if (point.x >= win.x && point.x <= win.x + win.w && point.y >= win.y && point.y <= win.y + win.h) return win
  }
  return null
}

function shotResizeSelection(selection, handle, start, current) {
  let left = selection.x
  let top = selection.y
  let right = selection.x + selection.w
  let bottom = selection.y + selection.h
  const deltaX = current.x - start.x
  const deltaY = current.y - start.y
  if (handle.indexOf('w') >= 0) left = Math.min(selection.x + deltaX, right - SHOT_MIN_SELECTION)
  if (handle.indexOf('e') >= 0) right = Math.max(selection.x + selection.w + deltaX, left + SHOT_MIN_SELECTION)
  if (handle.indexOf('n') >= 0) top = Math.min(selection.y + deltaY, bottom - SHOT_MIN_SELECTION)
  if (handle.indexOf('s') >= 0) bottom = Math.max(selection.y + selection.h + deltaY, top + SHOT_MIN_SELECTION)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/* -------------------------------------------------------------------------- */
/* annotation drawing                                                         */
/* -------------------------------------------------------------------------- */

function shotDrawAnnotation(ctx, fit, annotation) {
  const toDisplay = function toDisplay(x, y) {
    return shotImageToDisplay(fit, x, y)
  }
  ctx.save()
  ctx.strokeStyle = annotation.color
  ctx.fillStyle = annotation.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (annotation.type === 'rect') {
    const a = toDisplay(annotation.x1, annotation.y1)
    const b = toDisplay(annotation.x2, annotation.y2)
    ctx.lineWidth = annotation.lineWidth * fit.scale
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  } else if (annotation.type === 'ellipse') {
    const a = toDisplay(annotation.x1, annotation.y1)
    const b = toDisplay(annotation.x2, annotation.y2)
    ctx.lineWidth = annotation.lineWidth * fit.scale
    ctx.beginPath()
    ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (annotation.type === 'arrow') {
    const a = toDisplay(annotation.x1, annotation.y1)
    const b = toDisplay(annotation.x2, annotation.y2)
    const lineWidth = annotation.lineWidth * fit.scale
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const head = Math.max(10, lineWidth * 4)
    ctx.beginPath()
    ctx.moveTo(b.x, b.y)
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7))
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7))
    ctx.closePath()
    ctx.fill()
  } else if (annotation.type === 'pen') {
    const points = annotation.points
    if (points.length < 2) return
    ctx.lineWidth = annotation.lineWidth * fit.scale
    ctx.beginPath()
    const first = toDisplay(points[0].x, points[0].y)
    ctx.moveTo(first.x, first.y)
    for (let index = 1; index < points.length; index += 1) {
      const point = toDisplay(points[index].x, points[index].y)
      ctx.lineTo(point.x, point.y)
    }
    ctx.stroke()
  } else if (annotation.type === 'text') {
    const point = toDisplay(annotation.x, annotation.y)
    const fontPx = Math.max(6, annotation.fontSize * fit.scale)
    ctx.font = '600 ' + fontPx.toFixed(1) + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    ctx.textBaseline = 'top'
    const lines = String(annotation.text).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      ctx.fillText(lines[index], point.x, point.y + index * fontPx * 1.32)
    }
  }
  ctx.restore()
}

/** Map a host/client failure to user-facing localized copy where needed. */
function shotLocalizedErrorMessage(t, error) {
  if (error !== null && error.code === 'render-failed') return t('renderFailed')
  return error !== null && typeof error.message === 'string' ? error.message : String(error)
}

/** Render the selection crop with flattened annotations at native resolution. */
function shotRenderResult(image, selection, annotations) {  const sourceX = shotClamp(Math.round(selection.x), 0, image.naturalWidth || image.width)
  const sourceY = shotClamp(Math.round(selection.y), 0, image.naturalHeight || image.height)
  const sourceWidth = shotClamp(Math.round(selection.w), 1, (image.naturalWidth || image.width) - sourceX)
  const sourceHeight = shotClamp(Math.round(selection.h), 1, (image.naturalHeight || image.height) - sourceY)
  const canvas = document.createElement('canvas')
  canvas.width = sourceWidth
  canvas.height = sourceHeight
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new ShotError('2d context unavailable', 'render-failed')
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, sourceWidth, sourceHeight)
  ctx.clip()
  ctx.translate(-sourceX, -sourceY)
  const nativeFit = { scale: 1, imageWidth: sourceWidth, imageHeight: sourceHeight, offsetX: 0, offsetY: 0 }
  for (const annotation of annotations) shotDrawAnnotation(ctx, nativeFit, annotation)
  ctx.restore()
  return canvas.toDataURL('image/png')
}

/* -------------------------------------------------------------------------- */
/* editor component                                                           */
/* -------------------------------------------------------------------------- */

function ScreenshotEditor(props) {
  const t = props.t
  const shot = props.shot
  const onClose = props.onClose

  const virtualOrigin = props.virtual !== null && typeof props.virtual === 'object'
    && typeof props.virtual.x === 'number' && typeof props.virtual.y === 'number'
    ? { x: props.virtual.x, y: props.virtual.y }
    : { x: 0, y: 0 }

  /**
   * Top-level windows captured with the screenshot (z-order, topmost first),
   * converted to image pixel coordinates so hover hit-testing is O(n) with the
   * same coordinate space as the selection/annotations.
   */
  const windowRects = React.useMemo(function mapCaptureWindows() {
    const list = Array.isArray(props.windows) ? props.windows : []
    const mapped = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const x = Number(item.x)
      const y = Number(item.y)
      const width = Number(item.width)
      const height = Number(item.height)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue
      const left = shotClamp(x - virtualOrigin.x, 0, shot.width)
      const top = shotClamp(y - virtualOrigin.y, 0, shot.height)
      const right = shotClamp(x - virtualOrigin.x + width, 0, shot.width)
      const bottom = shotClamp(y - virtualOrigin.y + height, 0, shot.height)
      if (right - left < 2 || bottom - top < 2) continue
      mapped.push({
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
        title: typeof item.title === 'string' ? item.title : '',
      })
    }
    return mapped
  }, [props.windows, shot.width, shot.height, virtualOrigin.x, virtualOrigin.y])

  function windowAtImagePoint(point) {
    return shotWindowAtPoint(windowRects, point)
  }

  const canvasRef = React.useRef(null)
  const rootRef = React.useRef(null)
  const textInputRef = React.useRef(null)
  const pointerMode = React.useRef(null)

  const [viewport, setViewport] = React.useState(function initialViewport() {
    return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }
  })
  const [imageState, setImageState] = React.useState({ status: 'loading', image: null, error: null })
  const [selection, setSelection] = React.useState(null)
  const [annotations, setAnnotations] = React.useState([])
  const [redoStack, setRedoStack] = React.useState([])
  const [tool, setTool] = React.useState(null)
  const [color, setColor] = React.useState(SHOT_COLORS[0])
  const [draft, setDraft] = React.useState(null)
  const [hover, setHover] = React.useState(null)
  const [cursor, setCursor] = React.useState('crosshair')
  const [busy, setBusy] = React.useState(false)
  const [textDraft, setTextDraft] = React.useState(null)
  const [hintVisible, setHintVisible] = React.useState(true)
  const [hoverWindow, setHoverWindow] = React.useState(null)

  // Pointer interactions read the mirrored refs instead of the render-lagged
  // state snapshot; React state stays the single rendering source.
  const selectionRef = React.useRef(null)
  const annotationsRef = React.useRef([])
  const redoRef = React.useRef([])
  const draftRef = React.useRef(null)

  function updateSelection(value) {
    selectionRef.current = value
    setSelection(value)
  }
  function updateAnnotations(value) {
    annotationsRef.current = value
    setAnnotations(value)
  }
  function updateRedo(value) {
    redoRef.current = value
    setRedoStack(value)
  }
  function updateDraft(value) {
    draftRef.current = value
    setDraft(value)
  }

  const fit = shotFitImage(shot, viewport.w, viewport.h)
  const displayRect = selection === null ? null : shotImageRectToDisplay(fit, selection)

  /* ---- viewport + image ------------------------------------------------- */

  React.useEffect(function trackViewport() {
    const resize = function resize() {
      setViewport({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 })
    }
    window.addEventListener('resize', resize)
    return function cleanup() {
      window.removeEventListener('resize', resize)
    }
  }, [])

  React.useEffect(function loadImage() {
    let cancelled = false
    const image = new Image()
    image.onload = function onLoad() {
      if (!cancelled) setImageState({ status: 'ready', image, error: null })
    }
    image.onerror = function onError() {
      if (!cancelled) setImageState({ status: 'error', image: null, error: new ShotError('image decode failed', 'decode') })
    }
    image.src = shot.dataUrl
    return function cleanup() {
      cancelled = true
      image.onload = null
      image.onerror = null
    }
  }, [shot.dataUrl])

  /* ---- canvas painting -------------------------------------------------- */

  React.useLayoutEffect(function paint() {
    const canvas = canvasRef.current
    if (canvas === null) return
    const dpr = viewport.dpr
    const width = Math.max(1, Math.round(viewport.w * dpr))
    const height = Math.max(1, Math.round(viewport.h * dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, viewport.w, viewport.h)
    ctx.fillStyle = '#0b0b0d'
    ctx.fillRect(0, 0, viewport.w, viewport.h)
    const image = imageState.image
    if (image === null) return
    // 1. frozen desktop, letterboxed exactly like the coordinate mapping expects
    ctx.drawImage(image, fit.offsetX, fit.offsetY, fit.displayWidth, fit.displayHeight)
    // 2. dim everything outside the selection; while nothing is selected a
    //    hovered top-level window is highlighted instead (window snapping).
    ctx.fillStyle = 'rgba(0,0,0,0.46)'
    if (displayRect === null) {
      if (hoverWindow !== null) {
        const hoverRect = shotImageRectToDisplay(fit, hoverWindow)
        ctx.fillRect(0, 0, viewport.w, Math.max(0, hoverRect.y))
        ctx.fillRect(0, hoverRect.y + hoverRect.h, viewport.w, Math.max(0, viewport.h - hoverRect.y - hoverRect.h))
        ctx.fillRect(0, hoverRect.y, Math.max(0, hoverRect.x), hoverRect.h)
        ctx.fillRect(hoverRect.x + hoverRect.w, hoverRect.y, Math.max(0, viewport.w - hoverRect.x - hoverRect.w), hoverRect.h)
        ctx.save()
        ctx.strokeStyle = '#3ba7ff'
        ctx.lineWidth = 2
        ctx.strokeRect(hoverRect.x + 1, hoverRect.y + 1, Math.max(1, hoverRect.w - 2), Math.max(1, hoverRect.h - 2))
        ctx.restore()
      } else {
        ctx.fillRect(0, 0, viewport.w, viewport.h)
      }
    } else {
      ctx.fillRect(0, 0, viewport.w, Math.max(0, displayRect.y))
      ctx.fillRect(0, displayRect.y + displayRect.h, viewport.w, Math.max(0, viewport.h - displayRect.y - displayRect.h))
      ctx.fillRect(0, displayRect.y, Math.max(0, displayRect.x), displayRect.h)
      ctx.fillRect(displayRect.x + displayRect.w, displayRect.y, Math.max(0, viewport.w - displayRect.x - displayRect.w), displayRect.h)
    }
    // 3. annotations are clipped to the selected region, live in image space
    if (displayRect !== null) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(displayRect.x, displayRect.y, displayRect.w, displayRect.h)
      ctx.clip()
      for (const annotation of annotations) shotDrawAnnotation(ctx, fit, annotation)
      if (draft !== null) shotDrawAnnotation(ctx, fit, draft)
      ctx.restore()
      // 4. selection chrome
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 1
      ctx.strokeRect(displayRect.x + 0.5, displayRect.y + 0.5, Math.max(0, displayRect.w - 1), Math.max(0, displayRect.h - 1))
      ctx.fillStyle = '#ffffff'
      for (const handle of shotHandlesOf(displayRect)) {
        ctx.fillRect(handle.x - 3.5, handle.y - 3.5, 7, 7)
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        ctx.strokeRect(handle.x - 3.5, handle.y - 3.5, 7, 7)
      }
      ctx.restore()
    }
    // 5. crosshair while no region exists yet
    if (displayRect === null && hover !== null) {
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(hover.x + 0.5, 0)
      ctx.lineTo(hover.x + 0.5, viewport.h)
      ctx.moveTo(0, hover.y + 0.5)
      ctx.lineTo(viewport.w, hover.y + 0.5)
      ctx.stroke()
      ctx.restore()
    }
  }, [viewport, imageState, fit, displayRect, annotations, draft, hover, hoverWindow])

  /* ---- interaction ------------------------------------------------------ */

  function localPoint(event) {
    const root = rootRef.current
    if (root === null) return { x: 0, y: 0 }
    const box = root.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  function imagePoint(event) {
    const point = localPoint(event)
    return shotDisplayToImage(fit, point.x, point.y)
  }

  function currentLineWidth() {
    return SHOT_STROKE_DISPLAY / fit.scale
  }

  function onPointerDown(event) {
    if (event.button !== 0 || imageState.image === null) return
    event.preventDefault()
    setHintVisible(false)
    const point = localPoint(event)
    const image = shotDisplayToImage(fit, point.x, point.y)
    const canvas = canvasRef.current
    if (canvas !== null && canvas.setPointerCapture !== undefined) {
      try {
        canvas.setPointerCapture(event.pointerId)
      } catch (error) {
        /* pointer capture is best-effort */
      }
    }
    if (displayRect !== null) {
      const handle = shotHitHandle(point, displayRect)
      if (handle !== null) {
        pointerMode.current = { kind: 'resize', handle, start: image, origin: selectionRef.current }
        return
      }
      if (shotInsideDisplayRect(point, displayRect)) {
        if (tool === 'text') {
          pointerMode.current = null
          const target = shotImageToDisplay(fit, image.x, image.y)
          setTextDraft({ x: image.x, y: image.y, left: target.x, top: target.y, value: '' })
          return
        }
        if (tool === null) {
          pointerMode.current = { kind: 'move-selection', start: image, origin: selectionRef.current }
          return
        }
        const annotation = {
          type: tool,
          color,
          lineWidth: currentLineWidth(),
          fontSize: SHOT_FONT_DISPLAY / fit.scale,
          x1: image.x,
          y1: image.y,
          x2: image.x,
          y2: image.y,
          points: [{ x: image.x, y: image.y }],
        }
        pointerMode.current = { kind: 'draw', start: image }
        updateDraft(annotation)
        return
      }
    }
    pointerMode.current = { kind: 'select', start: image }
    updateAnnotations([])
    updateRedo([])
    updateSelection({ x: image.x, y: image.y, w: 0, h: 0 })
    setHoverWindow(null)
    setHintVisible(false)
  }

  function onPointerMove(event) {
    if (imageState.image === null) return
    const point = localPoint(event)
    const image = shotDisplayToImage(fit, point.x, point.y)
    if (pointerMode.current === null) {
      if (displayRect === null) {
        setHover({ x: point.x, y: point.y })
        const win = shotInsideDisplayRect(point, { x: fit.offsetX, y: fit.offsetY, w: fit.displayWidth, h: fit.displayHeight })
          ? windowAtImagePoint(image)
          : null
        setHoverWindow(win)
        setCursor(win !== null ? 'pointer' : 'crosshair')
      } else {
        setHoverWindow(null)
        const handle = shotHitHandle(point, displayRect)
        if (handle !== null) setCursor(SHOT_HANDLE_CURSORS[handle])
        else if (shotInsideDisplayRect(point, displayRect)) {
          setCursor(tool === 'text' ? 'text' : tool === null ? 'move' : 'crosshair')
        } else setCursor('crosshair')
      }
      return
    }
    const mode = pointerMode.current
    if (mode.kind === 'select') {
      updateSelection(shotRectFromPoints(mode.start, image, fit.imageWidth, fit.imageHeight))
    } else if (mode.kind === 'resize') {
      const next = shotResizeSelection(mode.origin, mode.handle, mode.start, image)
      updateSelection(shotNormalizeSelection(next, fit.imageWidth, fit.imageHeight))
    } else if (mode.kind === 'move-selection') {
      const origin = mode.origin
      if (origin === null) return
      const nextX = shotClamp(origin.x + (image.x - mode.start.x), 0, fit.imageWidth - origin.w)
      const nextY = shotClamp(origin.y + (image.y - mode.start.y), 0, fit.imageHeight - origin.h)
      updateSelection({ x: nextX, y: nextY, w: origin.w, h: origin.h })
    } else if (mode.kind === 'draw') {
      const previous = draftRef.current
      if (previous === null) return
      if (tool === 'pen') {
        updateDraft({ ...previous, points: previous.points.concat([{ x: image.x, y: image.y }]) })
      } else {
        updateDraft({ ...previous, x2: image.x, y2: image.y })
      }
    }
  }

  function onPointerUp(event) {
    if (pointerMode.current === null) return
    const mode = pointerMode.current
    pointerMode.current = null
    if (mode.kind === 'select') {
      const point = localPoint(event)
      const image = shotDisplayToImage(fit, point.x, point.y)
      const insideImage = point.x >= fit.offsetX && point.x <= fit.offsetX + fit.displayWidth
        && point.y >= fit.offsetY && point.y <= fit.offsetY + fit.displayHeight
      const deltaX = image.x - mode.start.x
      const deltaY = image.y - mode.start.y
      const moved = Math.sqrt(deltaX * deltaX + deltaY * deltaY)
      const clickSlop = 6 / fit.scale
      if (insideImage && moved <= clickSlop) {
        // A plain click (no drag) snaps to the window under the cursor, or to
        // the whole desktop when there is no window there (WeChat behaviour).
        const win = windowAtImagePoint(image)
        if (win !== null) {
          updateSelection({ x: win.x, y: win.y, w: win.w, h: win.h })
        } else {
          updateSelection({ x: 0, y: 0, w: shot.width, h: shot.height })
        }
        setHintVisible(false)
        return
      }
      const current = selectionRef.current
      if (insideImage && current !== null && current.w >= SHOT_MIN_SELECTION && current.h >= SHOT_MIN_SELECTION) {
        updateSelection(shotNormalizeSelection(current, fit.imageWidth, fit.imageHeight))
      } else {
        updateSelection(null)
      }
    } else if (mode.kind === 'draw') {
      const current = draftRef.current
      updateDraft(null)
      if (current !== null) {
        const tooTiny = current.type !== 'pen'
          && Math.abs(current.x2 - current.x1) < SHOT_MIN_SELECTION
          && Math.abs(current.y2 - current.y1) < SHOT_MIN_SELECTION
        const tooShort = current.type === 'pen' && current.points.length < 2
        if (!tooTiny && !tooShort) {
          updateAnnotations(annotationsRef.current.concat([current]))
          updateRedo([])
        }
      }
    }
    void event
  }

  function onWheel(event) {
    event.preventDefault()
  }

  /* ---- text annotations ------------------------------------------------- */

  React.useEffect(function focusTextDraft() {
    if (textDraft !== null && textInputRef.current !== null) {
      textInputRef.current.focus()
      textInputRef.current.select()
    }
  }, [textDraft !== null])

  function commitTextDraft() {
    const current = textDraft
    setTextDraft(null)
    if (current === null) return
    const value = current.value.replace(/\s+$/u, '')
    if (value.length === 0) return
    updateAnnotations(annotationsRef.current.concat([{
      type: 'text',
      color,
      lineWidth: 0,
      fontSize: SHOT_FONT_DISPLAY / fit.scale,
      x: current.x,
      y: current.y,
      x1: current.x,
      y1: current.y,
      x2: current.x,
      y2: current.y,
      points: [],
      text: current.value,
    }]))
    updateRedo([])
  }

  /* ---- confirm / save --------------------------------------------------- */

  function canCopy() {
    return selection !== null && imageState.image !== null && !busy
  }

  async function confirmCopy() {
    if (!canCopy()) return
    setBusy(true)
    try {
      const dataUrl = shotRenderResult(imageState.image, selection, annotations)
      await shotHostJson('/clipboard', { dataUrl }, 30000)
      const settings = shotReadSettings()
      let savedPath = null
      if (settings.autoSave) {
        try {
          const saved = await shotHostJson('/save', {
            dataUrl,
            directory: settings.saveDirectory.length > 0 ? settings.saveDirectory : undefined,
          }, 30000)
          savedPath = saved.path
        } catch (error) {
          shotPushToast({ kind: 'error', text: t('saveFailed', { message: shotLocalizedErrorMessage(t, error) }), duration: 6000 })
        }
      }
      shotPushToast({
        kind: 'success',
        text: savedPath !== null ? t('copiedAndSaved', { path: savedPath }) : t('copied'),
        action: savedPath !== null
          ? { label: t('openFolder'), onClick: function openFolder() { shotRevealPath(savedPath) } }
          : null,
        duration: savedPath !== null ? 6000 : 3200,
      })
      onClose()
    } catch (error) {
      shotPushToast({ kind: 'error', text: t('copyFailed', { message: shotLocalizedErrorMessage(t, error) }), duration: 6000 })
      setBusy(false)
    }
  }

  async function saveOnly() {
    if (selection === null || imageState.image === null || busy) return
    setBusy(true)
    try {
      const dataUrl = shotRenderResult(imageState.image, selection, annotations)
      const settings = shotReadSettings()
      const saved = await shotHostJson('/save', {
        dataUrl,
        directory: settings.saveDirectory.length > 0 ? settings.saveDirectory : undefined,
      }, 30000)
      shotPushToast({
        kind: 'success',
        text: t('saved', { path: saved.path }),
        action: { label: t('openFolder'), onClick: function openFolder() { shotRevealPath(saved.path) } },
        duration: 6000,
      })
      setBusy(false)
    } catch (error) {
      shotPushToast({ kind: 'error', text: t('saveFailed', { message: shotLocalizedErrorMessage(t, error) }), duration: 6000 })
      setBusy(false)
    }
  }

  function cancel() {
    if (busy) return
    onClose()
  }

  /* ---- undo / redo ------------------------------------------------------ */

  function undo() {
    const previous = annotationsRef.current
    if (previous.length === 0) return
    const last = previous[previous.length - 1]
    updateAnnotations(previous.slice(0, -1))
    updateRedo(redoRef.current.concat([last]))
  }

  function redo() {
    const previous = redoRef.current
    if (previous.length === 0) return
    const last = previous[previous.length - 1]
    updateRedo(previous.slice(0, -1))
    updateAnnotations(annotationsRef.current.concat([last]))
  }

  /* ---- keyboard --------------------------------------------------------- */

  React.useEffect(function keyboard() {
    const onKeyDown = function onKeyDown(event) {
      if (textDraft !== null) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setTextDraft(null)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (busy) return
        onClose()
      } else if (event.key === 'Enter' || event.key === 'NumpadEnter') {
        event.preventDefault()
        event.stopPropagation()
        if (canCopy()) void confirmCopy()
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault()
        event.stopPropagation()
        undo()
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault()
        event.stopPropagation()
        redo()
      } else if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault()
        event.stopPropagation()
        redo()
      } else if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
        event.preventDefault()
        event.stopPropagation()
        void saveOnly()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return function cleanup() {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [textDraft, busy, selection, annotations, redoStack, imageState])

  /* ---- render ----------------------------------------------------------- */

  const toolbar = displayRect === null ? null : h(ShotToolbar, {
    t,
    rect: displayRect,
    viewport,
    tool,
    color,
    busy,
    canUndo: annotations.length > 0,
    canRedo: redoStack.length > 0,
    onTool: function onTool(nextTool) { setTool(nextTool) },
    onColor: function onColor(nextColor) { setColor(nextColor) },
    onUndo: undo,
    onRedo: redo,
    onCancel: cancel,
    onSave: function onSave() { void saveOnly() },
    onCopy: function onCopy() { void confirmCopy() },
  })

  const sizeBadge = displayRect === null ? null : h('div', {
    className: 'dsh-shot-sizebadge',
    style: {
      left: shotClamp(displayRect.x, 6, viewport.w - 120) + 'px',
      top: shotClamp(displayRect.y - 24, 6, viewport.h - 30) + 'px',
    },
  }, Math.round(selection.w) + ' × ' + Math.round(selection.h))

  const hoverRectDisplay = displayRect === null && hoverWindow !== null
    ? shotImageRectToDisplay(fit, hoverWindow)
    : null
  const hoverBadge = hoverRectDisplay === null ? null : h('div', {
    className: 'dsh-shot-sizebadge dsh-shot-hoverbadge',
    style: {
      left: shotClamp(hoverRectDisplay.x, 6, viewport.w - 260) + 'px',
      top: shotClamp(hoverRectDisplay.y - 24, 6, viewport.h - 30) + 'px',
    },
  },
  (hoverWindow.title.length > 0 ? hoverWindow.title.slice(0, 48) + ' · ' : '')
    + Math.round(hoverWindow.w) + ' × ' + Math.round(hoverWindow.h))

  return h('div', {
    ref: rootRef,
    className: 'dsh-shot-overlay',
    onWheel,
    onContextMenu: function onContextMenu(event) { event.preventDefault() },
    onDoubleClick: function onDoubleClick(event) {
      if (displayRect !== null && shotInsideDisplayRect(localPoint(event), displayRect)) void confirmCopy()
    },
  },
    h('canvas', {
      ref: canvasRef,
      className: 'dsh-shot-canvas',
      style: {
        width: '100%',
        height: '100%',
        cursor,
        display: 'block',
        touchAction: 'none',
      },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave: function onPointerLeave() { if (pointerMode.current === null) setHover(null) },
    }),
    imageState.status === 'loading' ? h('div', { className: 'dsh-shot-loading' }, h(ShotSpinner, { size: 24 }), h('span', null, t('decoding'))) : null,
    imageState.status === 'error' ? h('div', { className: 'dsh-shot-loading' }, h('span', null, t('decodeFailed'))) : null,
    hintVisible && displayRect === null && imageState.status === 'ready'
      ? h('div', { className: 'dsh-shot-hint' }, t('hint'))
      : null,
    sizeBadge,
    hoverBadge,
    toolbar,
    textDraft !== null ? h('input', {
      ref: textInputRef,
      className: 'dsh-shot-textinput',
      style: {
        left: textDraft.left + 'px',
        top: textDraft.top + 'px',
        color,
        fontSize: SHOT_FONT_DISPLAY + 'px',
        caretColor: color,
        borderColor: color,
      },
      value: textDraft.value,
      placeholder: t('textPlaceholder'),
      onChange: function onChange(event) {
        const value = event.target.value
        setTextDraft(function update(current) {
          return current === null ? null : { ...current, value }
        })
      },
      onKeyDown: function onKeyDown(event) {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          commitTextDraft()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setTextDraft(null)
        }
      },
      onBlur: function onBlur() { commitTextDraft() },
    }) : null,
  )
}

/* -------------------------------------------------------------------------- */
/* toolbar                                                                    */
/* -------------------------------------------------------------------------- */

function ShotToolbar(props) {
  const t = props.t
  const widthGuess = 560
  const left = shotClamp(props.rect.x + props.rect.w - widthGuess, 8, Math.max(8, props.viewport.w - widthGuess - 8))
  const below = props.rect.y + props.rect.h + 10
  const above = props.rect.y - 54
  const top = below + 44 <= props.viewport.h ? below : above >= 8 ? above : shotClamp(props.rect.y + props.rect.h - 54, 8, props.viewport.h - 54)
  const toolButton = function toolButton(name, icon, label) {
    return h(ShotIconButton, {
      key: name,
      icon,
      label,
      active: props.tool === name,
      onClick: function onClick() { props.onTool(name) },
    })
  }
  const colorDot = function colorDot(value) {
    return h('button', {
      key: value,
      type: 'button',
      className: shotClassNames('dsh-shot-colordot', props.color === value && 'dsh-shot-colordot--active'),
      style: { background: value },
      title: value,
      'aria-label': value,
      onClick: function onClick() { props.onColor(value) },
    })
  }
  return h('div', {
    className: 'dsh-shot-toolbar',
    style: { left: left + 'px', top: top + 'px' },
    onPointerDown: function stop(event) { event.stopPropagation() },
    onDoubleClick: function stop(event) { event.stopPropagation() },
  },
    h('div', { className: 'dsh-shot-toolgroup' },
      toolButton('rect', ShotIconRect, t('toolRect')),
      toolButton('ellipse', ShotIconEllipse, t('toolEllipse')),
      toolButton('arrow', ShotIconArrow, t('toolArrow')),
      toolButton('pen', ShotIconPen, t('toolPen')),
      toolButton('text', ShotIconText, t('toolText')),
    ),
    h('div', { className: 'dsh-shot-toolgroup dsh-shot-colors' }, SHOT_COLORS.map(colorDot)),
    h('div', { className: 'dsh-shot-toolgroup' },
      h(ShotIconButton, { icon: ShotIconUndo, label: t('undo'), disabled: !props.canUndo, onClick: props.onUndo }),
      h(ShotIconButton, { icon: ShotIconRedo, label: t('redo'), disabled: !props.canRedo, onClick: props.onRedo }),
    ),
    h('div', { className: 'dsh-shot-toolgroup' },
      h(ShotIconButton, { icon: ShotIconClose, label: t('cancel'), onClick: props.onCancel }),
      h(ShotIconButton, { icon: ShotIconDownload, label: t('save'), onClick: props.onSave, disabled: props.busy }),
      h('button', {
        type: 'button',
        className: 'dsh-shot-confirm',
        title: t('copy'),
        disabled: props.busy,
        onClick: props.onCopy,
      }, props.busy ? h(ShotSpinner, { size: 15 }) : h(ShotIconCheck, { size: 16 }), h('span', null, t('copy'))),
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* overlay root + toasts                                                      */
/* -------------------------------------------------------------------------- */

function ShotOverlayRoot(props) {
  const t = props.t
  const overlay = shotUseOverlay()
  const toasts = shotUseToasts()
  const toastNodes = toasts.length === 0 ? null : h('div', { className: 'dsh-shot-toasts' },
    toasts.map(function renderToast(toast) {
      return h('div', {
        key: toast.id,
        className: shotClassNames('dsh-shot-toast', 'dsh-shot-toast--' + toast.kind),
        role: toast.kind === 'error' ? 'alert' : 'status',
      },
        h('span', { className: 'dsh-shot-toast__text' }, toast.text),
        toast.action !== null ? h('button', {
          type: 'button',
          className: 'dsh-shot-toast__action',
          onClick: function onClick() {
            toast.action.onClick()
            shotDismissToast(toast.id)
          },
        }, toast.action.label) : null,
        h('button', {
          type: 'button',
          className: 'dsh-shot-toast__close',
          'aria-label': t('dismiss'),
          onClick: function onClick() { shotDismissToast(toast.id) },
        }, h(ShotIconClose, { size: 12 })),
      )
    }),
  )
  return h('div', { className: 'dsh-shot-root' },
    overlay.phase === 'capturing' ? h('div', { className: 'dsh-shot-capturing' },
      h(ShotSpinner, { size: 26 }),
      h('div', { className: 'dsh-shot-capturing__text' }, t('capturing')),
    ) : null,
    overlay.phase === 'ready' && overlay.shot !== null
      ? h(ScreenshotEditor, {
        key: 'capture-' + overlay.captureSeq,
        shot: overlay.shot,
        windows: overlay.windows,
        virtual: overlay.virtual,
        t,
        onClose: shotCloseOverlay,
      })
      : null,
    toastNodes,
  )
}

/* -------------------------------------------------------------------------- */
/* reveal helper                                                              */
/* -------------------------------------------------------------------------- */

function shotRevealPath(path) {
  shotHostJson('/reveal', { path }, 8000).catch(function ignore() {
    /* opening the folder is a convenience; failures are not worth a second toast */
  })
}

/* -------------------------------------------------------------------------- */
/* styles                                                                     */
/* -------------------------------------------------------------------------- */

const SHOT_OVERLAY_CSS = [
  '.dsh-shot-root{position:fixed;inset:0;z-index:2147482000;pointer-events:none;font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif)}',
  '.dsh-shot-root *{box-sizing:border-box}',
  '.dsh-shot-overlay{position:fixed;inset:0;pointer-events:auto;background:#0b0b0d;user-select:none;-webkit-user-select:none;overflow:hidden}',
  '.dsh-shot-canvas{position:absolute;inset:0}',
  '.dsh-shot-hint{position:absolute;left:50%;top:18px;transform:translateX(-50%);padding:7px 14px;border-radius:999px;background:rgba(20,20,24,.78);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.92);font-size:12.5px;line-height:18px;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.35)}',
  '.dsh-shot-sizebadge{position:absolute;padding:3px 8px;border-radius:6px;background:rgba(20,20,24,.82);border:1px solid rgba(255,255,255,.16);color:#fff;font-size:11.5px;font-variant-numeric:tabular-nums;line-height:16px;pointer-events:none}',
  '.dsh-shot-hoverbadge{max-width:520px;border-color:rgba(59,167,255,.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-shot-loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:10px;color:rgba(255,255,255,.86);font-size:13px}',
  '.dsh-shot-toolbar{position:absolute;display:flex;align-items:center;gap:6px;padding:6px;border-radius:12px;background:rgba(24,24,28,.94);border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 36px rgba(0,0,0,.5);pointer-events:auto;backdrop-filter:blur(8px)}',
  '.dsh-shot-toolgroup{display:flex;align-items:center;gap:2px;padding:0 4px;border-right:1px solid rgba(255,255,255,.1)}',
  '.dsh-shot-toolgroup:last-child{border-right:none;padding-right:0}',
  '.dsh-shot-iconbtn{width:28px;height:28px;display:inline-grid;place-items:center;border-radius:7px;border:none;background:transparent;color:rgba(255,255,255,.82);cursor:pointer;padding:0}',
  '.dsh-shot-iconbtn:hover:not(:disabled){background:rgba(255,255,255,.12);color:#fff}',
  '.dsh-shot-iconbtn:active:not(:disabled){background:rgba(255,255,255,.2)}',
  '.dsh-shot-iconbtn:disabled{opacity:.35;cursor:default}',
  '.dsh-shot-iconbtn--active{background:rgba(255,255,255,.22);color:#fff}',
  '.dsh-shot-iconbtn--active:hover:not(:disabled){background:rgba(255,255,255,.3)}',
  '.dsh-shot-colordot{width:16px;height:16px;border-radius:999px;border:2px solid transparent;cursor:pointer;padding:0;margin:0 2px;box-shadow:0 0 0 1px rgba(0,0,0,.35)}',
  '.dsh-shot-colordot--active{border-color:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 0 0 2px rgba(255,255,255,.35)}',
  '.dsh-shot-confirm{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:7px;border:none;background:#2f86c9;color:#fff;font-size:12.5px;cursor:pointer}',
  '.dsh-shot-confirm:hover:not(:disabled){background:#3a94d8}',
  '.dsh-shot-confirm:disabled{opacity:.6;cursor:default}',
  '.dsh-shot-textinput{position:absolute;min-width:140px;max-width:60vw;padding:2px 4px;background:rgba(0,0,0,.06);border:1px dashed currentColor;border-radius:4px;outline:none;font-weight:600;line-height:1.3;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
  '.dsh-shot-capturing{position:fixed;inset:0;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(8,8,10,.55);color:#fff;backdrop-filter:blur(2px)}',
  '.dsh-shot-capturing__text{font-size:13px;letter-spacing:.02em}',
  '.dsh-shot-toasts{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;z-index:2147482100}',
  '.dsh-shot-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;max-width:min(640px,calc(100vw - 48px));padding:9px 12px;border-radius:10px;background:rgba(28,28,32,.96);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.94);font-size:12.5px;line-height:18px;box-shadow:0 10px 30px rgba(0,0,0,.42)}',
  '.dsh-shot-toast--error{border-color:rgba(255,96,92,.55)}',
  '.dsh-shot-toast--success{border-color:rgba(60,200,140,.5)}',
  '.dsh-shot-toast__text{overflow-wrap:anywhere}',
  '.dsh-shot-toast__action{border:none;background:rgba(255,255,255,.14);color:#fff;font-size:12px;padding:4px 9px;border-radius:6px;cursor:pointer;white-space:nowrap}',
  '.dsh-shot-toast__action:hover{background:rgba(255,255,255,.22)}',
  '.dsh-shot-toast__close{display:inline-grid;place-items:center;width:18px;height:18px;border:none;background:transparent;color:rgba(255,255,255,.6);cursor:pointer;padding:0}',
  '.dsh-shot-toast__close:hover{color:#fff}',
  '.dsh-shot-spin{animation:dsh-shot-rotate .9s linear infinite}',
  '@keyframes dsh-shot-rotate{to{transform:rotate(360deg)}}',
].join('\n')

