/** 独立构建 DSH Client 工厂；框架共享模块必须由 Host 的模块表提供。 */
import { build, context } from 'esbuild'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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
async function emit(result) {
  if (result.errors.length) return
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
  // 原生 ToolRow 的 CSS Modules 随构建内联，跟随插件生命周期装卸。
  const installStyle = 'const originalApply = module.exports.apply; module.exports = {...module.exports, apply(ctx) { ctx.effect(() => { const style = document.createElement("style"); style.dataset.stepReviewStyle = ""; style.textContent = ' + JSON.stringify(css) + '; document.head.append(style); return () => style.remove(); }); return originalApply(ctx); }};\n'
  const source = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(manifest.name) + ', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n' + js + '\n' + installStyle + '\nreturn module.exports;\n} });\n'
  await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
  await writeFile(new URL('../lib/client.js', import.meta.url), source)
  console.log('已构建 lib/client.js（DSH 模块工厂）')
}
if (watch) {
  const compiler = await context({ ...options, plugins: [{ name: 'step-review-client', setup(build) { build.onEnd(emit) } }] })
  await compiler.watch()
  console.log('正在监听插件客户端源码。')
} else await emit(await build(options))
