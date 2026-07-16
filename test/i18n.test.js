import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const localesDir = resolve(__dirname, '../src/_locales')
const srcDir = resolve(__dirname, '../src')

const locales = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

function loadLocale(locale) {
  return JSON.parse(readFileSync(resolve(localesDir, locale, 'messages.json'), 'utf8'))
}

/** Extract the $TOKEN$ placeholders used inside a message string. */
function placeholderTokens(message) {
  return new Set((message.match(/\$[A-Za-z0-9_]+\$/g) || []).map((tokenMatch) => tokenMatch.toUpperCase()))
}

const en = loadLocale('en')

describe('locale catalogues', () => {
  it('ships the default locale', () => {
    expect(locales).toContain('en')
  })

  it('has valid keys and non-empty messages everywhere', () => {
    for (const locale of locales) {
      const messages = loadLocale(locale)
      for (const [key, entry] of Object.entries(messages)) {
        expect(key, `${locale}/${key}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
        expect(typeof entry.message, `${locale}/${key}`).toBe('string')
        expect(entry.message.length, `${locale}/${key} empty`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps every locale key a subset of en (missing keys fall back to en)', () => {
    const enKeys = new Set(Object.keys(en))
    for (const locale of locales) {
      if (locale === 'en') continue
      for (const key of Object.keys(loadLocale(locale))) {
        expect(enKeys.has(key), `${locale} has unknown key: ${key}`).toBe(true)
      }
    }
  })

  it('keeps placeholder tokens consistent with en', () => {
    for (const locale of locales) {
      if (locale === 'en') continue
      const messages = loadLocale(locale)
      for (const [key, entry] of Object.entries(messages)) {
        const expected = placeholderTokens(en[key]?.message || '')
        expect(placeholderTokens(entry.message), `${locale}/${key} placeholders`).toEqual(expected)
        if (en[key]?.placeholders) {
          expect(entry.placeholders, `${locale}/${key} placeholders block`).toEqual(en[key].placeholders)
        }
      }
    }
  })

  it('covers every key referenced from source', () => {
    const referenced = new Set()
    for (const file of ['popup.js', 'approve.js', 'popup.html', 'approve.html']) {
      const source = readFileSync(resolve(srcDir, file), 'utf8')
      for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) referenced.add(match[1])
      for (const match of source.matchAll(/data-i18n(?:-placeholder|-title)?="([A-Za-z0-9_]+)"/g)) referenced.add(match[1])
    }
    referenced.add('extDescription') // manifest __MSG_extDescription__
    for (const key of referenced) {
      expect(en[key], `en missing key: ${key}`).toBeDefined()
    }
  })
})
