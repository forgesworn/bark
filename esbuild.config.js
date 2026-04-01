import esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWatch = process.argv.includes('--watch')
const srcDir = resolve(__dirname, 'src')
const distDir = resolve(__dirname, 'dist')

// Ensure dist directories exist
mkdirSync(resolve(distDir, 'icons'), { recursive: true })

// Copy static files to dist
function copyStatic() {
  cpSync(resolve(srcDir, 'manifest.json'), resolve(distDir, 'manifest.json'))
  cpSync(resolve(srcDir, 'popup.html'), resolve(distDir, 'popup.html'))
  cpSync(resolve(srcDir, 'icons'), resolve(distDir, 'icons'), { recursive: true })
  // Copy unbundled scripts (they run in page/content context)
  cpSync(resolve(srcDir, 'provider.js'), resolve(distDir, 'provider.js'))
  cpSync(resolve(srcDir, 'content-script.js'), resolve(distDir, 'content-script.js'))
}

copyStatic()

// Bundle background.js and popup.js as IIFE for Chrome extension context
const buildOptions = {
  entryPoints: [
    resolve(srcDir, 'background.js'),
    resolve(srcDir, 'popup.js'),
  ],
  bundle: true,
  format: 'iife',
  outdir: distDir,
  logLevel: 'info',
  plugins: [
    {
      name: 'copy-static-on-rebuild',
      setup(build) {
        build.onEnd(() => {
          copyStatic()
        })
      },
    },
  ],
}

if (isWatch) {
  const ctx = await esbuild.context(buildOptions)
  await ctx.watch()
  console.log('Watching for changes...')
} else {
  await esbuild.build(buildOptions)
}
