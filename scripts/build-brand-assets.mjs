// Render the canonical Browser gate vector into extension, site and store icons.
// Run npm run brand:build after editing src/icons/bark.svg.
import { chromium } from '@playwright/test'
import { readFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(path.join(root, 'src/icons/bark.svg'), 'utf8')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const size of [16, 48, 128]) {
    // The hairline ring and browser chrome dots become noise at toolbar size.
    const svg = size === 16 ? source.replace(/<circle[^>]*r="(?:38\.4|1\.8)"[^>]*\/>/g, '') : source
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`)
    await page.screenshot({ path: path.join(root, `src/icons/bark-${size}.png`), omitBackground: true })
  }
  for (const size of [48, 128]) copyFileSync(path.join(root, `src/icons/bark-${size}.png`), path.join(root, `site/assets/bark-${size}.png`))
  copyFileSync(path.join(root, 'src/icons/bark-128.png'), path.join(root, 'docs/store-assets/store-icon-128.png'))
  copyFileSync(path.join(root, 'src/icons/bark.svg'), path.join(root, 'site/assets/bark.svg'))
} finally { await browser.close() }
