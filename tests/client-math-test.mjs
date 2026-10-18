#!/usr/bin/env node
// Pure-math smoke test for the dsh-screencapture client bundle sources.
// Extracts the side-effect-free helpers from the source modules (they are plain
// function declarations in a shared bundle scope) and asserts coordinate
// mapping, selection geometry and chord matching.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shared = readFileSync(join(root, 'src', 'client', '00-shared.js'), 'utf8')
const overlay = readFileSync(join(root, 'src', 'client', '10-overlay.js'), 'utf8')

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`marker not found: ${startMarker} / ${endMarker}`)
  return source.slice(start, end)
}

const chord = slice(shared, '/* chord helpers', '/* host API')
const helpersBlock = slice(shared, '/* errors, helpers', '/* settings store')
const geometry = slice(overlay, '/* geometry helpers', '/* annotation drawing')
const constants = overlay.slice(overlay.indexOf('const SHOT_COLORS'), overlay.indexOf('/* -------------------------------------------------------------------------- */\n/* geometry helpers'))

const code = `
${helpersBlock}
${constants}
${chord}
${geometry}
return {
  shotClamp, shotFitImage, shotDisplayToImage, shotImageToDisplay, shotImageRectToDisplay,
  shotRectFromPoints, shotNormalizeSelection, shotHandlesOf, shotHitHandle, shotResizeSelection,
  shotInsideDisplayRect, shotWindowAtPoint,
  shotChordFromEvent, shotIsEligibleChord, shotChordsEqual, shotFormatChord, shotCodeLabel,
}
`
const helpers = new Function(code)()

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}\n  actual   ${a}\n  expected ${b}`)
  }
}
const near = (v, t = 0.000001) => Math.abs(v - t) < 1e-6

// 1. exact fit (same aspect ratio)
const fitEqual = helpers.shotFitImage({ width: 2560, height: 1440 }, 1280, 720)
check('fit scale same aspect', [near(fitEqual.scale, 0.5), near(fitEqual.offsetX, 0), near(fitEqual.offsetY, 0)], [true, true, true])
const centerImage = helpers.shotDisplayToImage(fitEqual, 640, 360)
check('display center -> image center', [near(centerImage.x, 1280), near(centerImage.y, 720)], [true, true])

// 2. letterboxed fit (window narrower than image aspect)
const fitBox = helpers.shotFitImage({ width: 2000, height: 1000 }, 1000, 1000)
check('fit letterbox offsets', [near(fitBox.scale, 0.5), near(fitBox.displayHeight, 500), near(fitBox.offsetY, 250)], [true, true, true])
check('image origin -> display offset', helpers.shotImageToDisplay(fitBox, 0, 0), { x: 0, y: 250 })
const roundTrip = helpers.shotDisplayToImage(fitBox, 250, 375)
check('round trip', [near(roundTrip.x, 500), near(roundTrip.y, 250)], [true, true])

// 3. drag rect in any direction, clamped to image bounds
check('rect reverse drag', helpers.shotRectFromPoints({ x: 300, y: 400 }, { x: 100, y: 150 }, 2000, 1000), { x: 100, y: 150, w: 200, h: 250 })
check('rect clamped', helpers.shotRectFromPoints({ x: -50, y: -20 }, { x: 2200, y: 1200 }, 2000, 1000), { x: 0, y: 0, w: 2000, h: 1000 })

// 4. handles + hit testing
const displayRect = { x: 100, y: 80, w: 200, h: 120 }
check('handle count', helpers.shotHandlesOf(displayRect).length, 8)
check('hit se handle', helpers.shotHitHandle({ x: 302, y: 199 }, displayRect), 'se')
check('miss handle', helpers.shotHitHandle({ x: 200, y: 140 }, displayRect), null)

// 5. resize: east edge extends by 40 image px
const resized = helpers.shotResizeSelection({ x: 100, y: 100, w: 200, h: 100 }, 'e', { x: 300, y: 150 }, { x: 340, y: 150 })
check('resize east', resized, { x: 100, y: 100, w: 240, h: 100 })
const resizedMin = helpers.shotResizeSelection({ x: 100, y: 100, w: 200, h: 100 }, 'w', { x: 100, y: 150 }, { x: 500, y: 150 })
check('resize west keeps min width', resizedMin.w >= 6, true)

// 6. selection normalization
check('normalize clamps', helpers.shotNormalizeSelection({ x: 1990, y: 990, w: 100, h: 100 }, 2000, 1000), { x: 1990, y: 990, w: 10, h: 10 })

// 7. chords
check('chord from event', helpers.shotChordFromEvent({ code: 'KeyA', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }), { code: 'KeyA', ctrl: true, shift: true, alt: false, meta: false })
check('modifier-only chord is null', helpers.shotChordFromEvent({ code: 'ShiftLeft', shiftKey: true }), null)
check('format default', helpers.shotFormatChord({ code: 'KeyA', ctrl: true, shift: true, alt: false, meta: false }), 'Ctrl + Shift + A')
check('eligible default', helpers.shotIsEligibleChord({ code: 'KeyA', ctrl: true, shift: true, alt: false, meta: false }), true)
check('ineligible plain key', helpers.shotIsEligibleChord({ code: 'KeyA', ctrl: false, shift: false, alt: false, meta: false }), false)
check('ineligible modifier only', helpers.shotIsEligibleChord({ code: 'ControlLeft', ctrl: true, shift: false, alt: false, meta: false }), false)
check('chords equal', helpers.shotChordsEqual({ code: 'KeyA', ctrl: true, shift: true, alt: false, meta: false }, { code: 'KeyA', ctrl: true, shift: true, alt: false, meta: false }), true)
check('chords differ on modifier', helpers.shotChordsEqual({ code: 'KeyA', ctrl: true, shift: true, alt: false, meta: false }, { code: 'KeyA', ctrl: true, shift: false, alt: false, meta: false }), false)
check('code label digit', helpers.shotCodeLabel('Digit5'), '5')
check('code label fkey', helpers.shotCodeLabel('F11'), 'F11')

// 8. window snapping hit-test: z-ordered list, topmost containing window wins
const captureWindows = [
  { x: 100, y: 100, w: 200, h: 150, title: 'top' },
  { x: 0, y: 0, w: 500, h: 400, title: 'behind' },
]
check('window hit topmost', helpers.shotWindowAtPoint(captureWindows, { x: 150, y: 150 })?.title, 'top')
check('window hit behind', helpers.shotWindowAtPoint(captureWindows, { x: 450, y: 350 })?.title, 'behind')
check('window hit miss', helpers.shotWindowAtPoint(captureWindows, { x: 600, y: 600 }), null)
check('window hit empty list', helpers.shotWindowAtPoint([], { x: 0, y: 0 }), null)
check('window hit non-list', helpers.shotWindowAtPoint(null, { x: 0, y: 0 }), null)

if (failures > 0) {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall client math checks passed')
