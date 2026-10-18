#!/usr/bin/env node
// Locale dictionary parity check for the dsh-screencapture client bundle: the
// Harness locale service enforces bilingual balance (zh and en must carry the
// exact same key set), so validate it before installing.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src', 'client', '30-entry.js'), 'utf8')

function extractDictionary(name) {
  const start = source.indexOf(`const ${name} = {`)
  if (start < 0) throw new Error(`${name} not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  let index = open
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1
        index += 1
      }
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
    index += 1
  }
  const literal = source.slice(open, index + 1)
  // The dictionaries are plain object literals; evaluate them in isolation.
  return new Function(`return (${literal})`)()
}

const zh = extractDictionary('SHOT_LOCALE_ZH')
const en = extractDictionary('SHOT_LOCALE_EN')
const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
let failures = 0

function report(label, ok, detail) {
  if (ok) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${detail}` : ''}`)
  }
}

report('locale key parity', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
  `zh-only=[${zhKeys.filter((key) => !(key in en)).join(',')}] en-only=[${enKeys.filter((key) => !(key in zh)).join(',')}]`)
report('dictionary size', zhKeys.length > 40, `keys=${zhKeys.length}`)

// Every t('...') key used by the client modules must exist in the dictionaries.
const files = ['00-shared.js', '10-overlay.js', '20-settings.js', '30-entry.js']
const used = new Set()
for (const file of files) {
  const text = readFileSync(join(root, 'src', 'client', file), 'utf8')
  for (const match of text.matchAll(/\bt\('([^']+)'/g)) used.add(match[1])
  for (const match of text.matchAll(/translate\('([^']+)'/g)) used.add(match[1])
}
const missing = [...used].filter((key) => !(key in zh) || !(key in en))
report('all used t() keys exist', missing.length === 0, `missing=[${missing.join(',')}]`)
const unused = zhKeys.filter((key) => !used.has(key))
report('no unused keys (informational)', true, unused.length > 0 ? `unused=[${unused.join(',')}]` : 'none')

// Nested translation parameters must reference existing keys too (smoke pass:
// every '{placeholder}' appears in both languages for that key).
const placeholderProblems = []
for (const key of zhKeys) {
  const params = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  if (params(zh[key]) !== params(en[key])) placeholderProblems.push(key)
}
report('placeholder parity', placeholderProblems.length === 0, `mismatch=[${placeholderProblems.join(',')}]`)

process.exit(failures === 0 ? 0 : 1)
