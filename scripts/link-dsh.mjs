/** 将本插件的开发依赖链接到已构建的 DSH checkout，不修改 checkout。 */
import { readdir, mkdir, lstat, stat, symlink, readFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const checkoutPath = process.argv[2] ?? process.env.DSH_CHECKOUT
if (!checkoutPath) throw new Error('请传入 DSH checkout 路径，或设置 DSH_CHECKOUT。')
const checkout = resolve(checkoutPath)
const map = new Map()
const groups = (await readdir(join(checkout, 'packages'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => 'packages/' + item.name)
for (const parent of ['vendor', ...groups]) {
  for (const dir of await readdir(join(checkout, parent), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const path = join(checkout, parent, dir.name)
    let manifest
    try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    map.set(manifest.name, path)
  }
}
for (const name of ['typescript', '@types/node', 'react', '@types/react', 'esbuild', 'yaml', 'react-dom', 'clsx']) {
  let source = join(checkout, 'node_modules', name)
  try { await stat(source) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const prefix = name === 'esbuild' ? 'esbuild@0.25.' : name.replace('/', '+') + '@'
    const selected = (await readdir(join(checkout, 'node_modules/.pnpm'))).filter(item => item.startsWith(prefix)).sort().at(-1)
    if (!selected) throw new Error('checkout 缺少开发依赖：' + name)
    source = join(checkout, 'node_modules/.pnpm', selected, 'node_modules', name)
  }
  map.set(name, source)
}
const own = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const name of new Set([...Object.keys(own.dependencies), ...Object.keys(own.peerDependencies), ...Object.keys(own.devDependencies)])) {
  const source = map.get(name)
  if (!source) throw new Error('checkout 中没有依赖：' + name)
  const target = join(root, 'node_modules', name)
  await mkdir(resolve(target, '..'), { recursive: true })
  try {
    const entry = await lstat(target)
    try { await stat(target); continue } catch (error) {
      if (error.code !== 'ENOENT' || !entry.isSymbolicLink()) throw error
      // target 是上方已核对的本插件 node_modules 依赖路径，仅移除失效链接本身。
      await unlink(target)
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}
console.log('已链接当前 DSH checkout 的依赖：' + checkout)
