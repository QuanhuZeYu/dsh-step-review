/** 独立构建 DSH Client 工厂；框架共享模块必须由 Host 的模块表提供。 */
import { build, context } from 'esbuild'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { wrapStatistics } from '../src/client/stats-speed.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const watch = process.argv.includes('--watch')
const options = {
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'client.js',
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/cordis', '@deepseek-ai/cordis/*', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  define: { 'process.env.NODE_ENV': '"production"' },
}
async function statisticsFactory() {
  const upstreamManifest = new URL(import.meta.resolve('@deepseek-ai/dsh-experimental-client-ui-stats/package.json'))
  const upstream = JSON.parse(await readFile(upstreamManifest, 'utf8'))
  if (upstream.version !== '0.2.2-rc.5') throw Error('统计组件版本不匹配，需要 0.2.2-rc.5')
  const original = await readFile(new URL('lib/client.js', upstreamManifest), 'utf8')
  const marker = 'window.__ModuleLoader__.load('
  if (!original.trimStart().startsWith(marker) || original.indexOf(marker) !== original.lastIndexOf(marker)) throw Error('原统计组件构建入口无法识别')
  return 'const statistics = (() => { let original; const loadOriginal = entry => { original = entry.factory(require) };\n'
    + original.split('\n').filter(line => !line.startsWith('//# sourceMappingURL=')).join('\n').replace(marker, 'loadOriginal(')
    + '\nreturn (' + wrapStatistics.toString() + ')(require, original); })();\n'
    + 'const review = module.exports; module.exports = {...review, inject: [...new Set([...review.inject, ...statistics.inject])], apply(ctx) { review.apply(ctx); return statistics.apply(ctx); }};\n'
}
async function emit(result) {
  if (result.errors.length) return
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
  // 原生 ToolRow 的 CSS Modules 随构建内联，跟随插件生命周期装卸。
  const installStyle = 'const originalApply = module.exports.apply; module.exports = {...module.exports, apply(ctx) { ctx.effect(() => { const style = document.createElement("style"); style.dataset.stepReviewStyle = ""; style.textContent = ' + JSON.stringify(css) + '; document.head.append(style); return () => style.remove(); }); return originalApply(ctx); }};\n'
  const source = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(manifest.name) + ', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n' + js + '\n' + await statisticsFactory() + '\n' + installStyle + '\nreturn module.exports;\n} });\n'
  await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
  await writeFile(new URL('../lib/client.js', import.meta.url), source)
  console.log('已构建 lib/client.js（DSH 模块工厂）')
}
if (watch) {
  const compiler = await context({ ...options, plugins: [{ name: 'step-review-client', setup(build) { build.onEnd(emit) } }] })
  await compiler.watch()
  console.log('正在监听插件客户端源码。')
} else await emit(await build(options))
