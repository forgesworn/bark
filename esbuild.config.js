import esbuild from 'esbuild'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWatch = process.argv.includes('--watch')
const target = process.argv.find(arg => arg.startsWith('--target='))?.split('=')[1] || 'chromium'
const supportedTargets = new Set(['chromium', 'firefox', 'safari'])
if (!supportedTargets.has(target)) {
  throw new Error(`Unsupported build target: ${target}`)
}

const srcDir = resolve(__dirname, 'src')
const distDir = resolve(__dirname, target === 'chromium' ? 'dist' : `dist-${target}`)

// Ensure dist directories exist
if (!isWatch) rmSync(distDir, { recursive: true, force: true })
mkdirSync(resolve(distDir, 'icons'), { recursive: true })

function manifestForTarget() {
  const manifest = JSON.parse(readFileSync(resolve(srcDir, 'manifest.json'), 'utf8'))

  if (target === 'firefox') {
    // Firefox MV3 uses event-page background scripts while Chromium uses
    // service workers. The bundled background is an IIFE, so no module flag is
    // required here.
    manifest.background = {
      scripts: ['background.js'],
    }
    // Chromium never gates WebSockets on host permissions, so the base
    // manifest omits these. Firefox's behaviour is less clearly documented;
    // keep the declared (user-optional in MV3) relay permissions there.
    // Match patterns ignore ports, so the loopback entries cover any port.
    manifest.host_permissions = ['wss://*/*', 'ws://localhost/*', 'ws://127.0.0.1/*']
    manifest.browser_specific_settings = {
      gecko: {
        id: 'bark@forgesworn.local',
        strict_min_version: '128.0',
        // Required for new AMO submissions. Bark collects nothing.
        data_collection_permissions: {
          required: ['none'],
        },
      },
    }
  }

  if (target === 'safari') {
    manifest.name = 'Bark for Safari'
    manifest.background = {
      service_worker: 'background.js',
    }
    // Safari lacks reliable MAIN-world content script support, so it keeps
    // the script-tag injection path (see __BARK_INJECT_PROVIDER__ below).
    manifest.content_scripts = manifest.content_scripts.filter(cs => cs.world !== 'MAIN')
    manifest.web_accessible_resources = [
      {
        resources: ['provider.js'],
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
      },
    ]
  }

  return manifest
}

// Copy static files to dist
function copyStatic() {
  writeFileSync(
    resolve(distDir, 'manifest.json'),
    `${JSON.stringify(manifestForTarget(), null, 2)}\n`,
  )
  cpSync(resolve(srcDir, 'popup.html'), resolve(distDir, 'popup.html'))
  cpSync(resolve(srcDir, 'icons'), resolve(distDir, 'icons'), { recursive: true })
  cpSync(resolve(srcDir, 'approve.html'), resolve(distDir, 'approve.html'))
  cpSync(resolve(srcDir, 'diagnostic.html'), resolve(distDir, 'diagnostic.html'))
}

copyStatic()

// Bundle background.js and popup.js as IIFE for Chrome extension context
const buildOptions = {
  entryPoints: [
    resolve(srcDir, 'background.js'),
    resolve(srcDir, 'popup.js'),
    resolve(srcDir, 'approve.js'),
    resolve(srcDir, 'content-script.js'),
    resolve(srcDir, 'provider.js'),
  ],
  bundle: true,
  format: 'iife',
  outdir: distDir,
  logLevel: 'info',
  define: {
    // Safari falls back to script-tag provider injection; Chromium and
    // Firefox use the declarative MAIN-world content script instead.
    __BARK_INJECT_PROVIDER__: target === 'safari' ? 'true' : 'false',
  },
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

const isPackage = process.argv.includes('--package')

if (isWatch) {
  const ctx = await esbuild.context(buildOptions)
  await ctx.watch()
  console.log(`Watching ${target} build for changes...`)
} else {
  await esbuild.build(buildOptions)

  if (isPackage) {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))
    const zipName = target === 'chromium'
      ? `bark-v${pkg.version}.zip`
      : `bark-${target}-v${pkg.version}.zip`
    rmSync(resolve(__dirname, zipName), { force: true })
    execSync(`cd "${distDir}" && zip -r "../${zipName}" .`)
    console.log(`Packaged: ${zipName}`)
  }
}
