// Render the canonical Browser gate vector into extension, site and store icons.
// Run npm run brand:build after editing either source SVG in src/icons/.
import { chromium } from '@playwright/test'
import { readFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(path.join(root, 'src/icons/bark.svg'), 'utf8')
const toolbar = readFileSync(path.join(root, 'src/icons/bark-toolbar.svg'), 'utf8')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const render = async (svg, size, destination) => {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`)
    await page.screenshot({ path: path.join(root, destination), omitBackground: true })
  }
  // Dedicated toolbar artwork fills the slot at 1x, 2x and 3x display scale.
  // Site and store artwork keeps the canonical full-size Browser gate.
  for (const size of [16, 32, 48]) await render(toolbar, size, `src/icons/bark-${size}.png`)
  await render(source, 128, 'src/icons/bark-128.png')
  await render(source, 48, 'site/assets/bark-48.png')
  copyFileSync(path.join(root, 'src/icons/bark-128.png'), path.join(root, 'site/assets/bark-128.png'))
  copyFileSync(path.join(root, 'src/icons/bark-128.png'), path.join(root, 'docs/store-assets/store-icon-128.png'))
  copyFileSync(path.join(root, 'src/icons/bark.svg'), path.join(root, 'site/assets/bark.svg'))
} finally { await browser.close() }
