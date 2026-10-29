import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import type { Plugin } from 'vite-plus'
import { discoverExtensions } from './discovery.ts'
import { discoveryRoots } from './project.ts'
import { watchRoots } from './watch-roots.ts'
import { extensionSettingsFiles } from './extension-settings.ts'
import { useProjectSetup } from './project-setup.ts'

const virtual = 'virtual:ultimate/web-facets'
const resolved = '\0' + virtual
export function extensionModules(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string,
): Plugin {
  const roots = discoveryRoots(ultimateRoot, projectRoot, userHome).map((root) =>
    join(root.path, 'extensions'),
  )
  const trustFile = join(userHome, '.ultimate/trust.json')
  const settingsFiles = [...extensionSettingsFiles(projectRoot, userHome), trustFile]
  const watchers = new WeakMap<object, () => void>()
  let sourcesFile = ''
  return {
    name: 'ultimate:extension-modules',
    configResolved(config) {
      sourcesFile = join(config.cacheDir, 'extension-sources.css')
    },
    closeBundle() {
      watchers.get(this.environment)?.()
      watchers.delete(this.environment)
    },
    enforce: 'pre',
    async config() {
      const modules = join(ultimateRoot, 'node_modules')
      const entries = await readdir(modules)
      const packages = (
        await Promise.all(
          entries
            .filter((name) => !name.startsWith('.'))
            .map(async (name) =>
              name.startsWith('@')
                ? (await readdir(join(modules, name))).map((child) => `${name}/${child}`)
                : [name],
            ),
        )
      ).flat()
      return { resolve: { dedupe: packages } }
    },
    async resolveId(id, importer, options) {
      if (id === virtual) return resolved
      if (
        !importer ||
        options.ssr ||
        !roots.slice(1).some((root) => importer.startsWith(root + '/')) ||
        id.startsWith('.') ||
        id.startsWith('/') ||
        id.startsWith('\0')
      )
        return undefined
      if (id.startsWith('@/'))
        return this.resolve(join(ultimateRoot, 'web/src', id.slice(2)), importer, {
          ...options,
          skipSelf: true,
        })
      if (id.startsWith('node:')) return undefined
      const dependency = await this.resolve(id, join(ultimateRoot, 'package.json'), {
        ...options,
        skipSelf: true,
      })
      return dependency
    },
    async load(id) {
      if (id.split('?')[0] === join(ultimateRoot, 'web/src/index.css')) {
        // Tailwind skips a git-ignored symlinked extension inside a root, so its target is a source of its own.
        const linked = (await discoverExtensions(ultimateRoot, projectRoot, userHome))
          .filter(
            (entry) => entry.source !== 'builtin' && !entry.error && entry.target !== entry.path,
          )
          .map((entry) => entry.target)
        const sources = [
          ...roots.filter(
            (root, index) =>
              existsSync(root) && (index !== 2 || useProjectSetup(projectRoot, userHome)),
          ),
          ...linked,
        ]
          .map((root) => `@source ${JSON.stringify(root)};\n`)
          .join('')
        // Tailwind keeps its compiler, and so its sources, until an imported file's mtime changes: the sources live in
        // their own file, rewritten when a root appears, a link is added or the project's trust changes. A scanner
        // never picks up a source folder that was missing when it started, so only existing roots are listed.
        const current = await readFile(sourcesFile, 'utf8').catch(() => undefined) // Missing until the first write.
        if (current !== sources) {
          await mkdir(dirname(sourcesFile), { recursive: true })
          await writeFile(sourcesFile, sources)
        }
        return (
          (await readFile(join(ultimateRoot, 'web/src/index.css'), 'utf8')) +
          `\n@import ${JSON.stringify(sourcesFile)};\n`
        )
      }
      if (id !== resolved) return undefined
      const facets = (await discoverExtensions(ultimateRoot, projectRoot, userHome)).filter(
        (entry) => entry.enabled && entry.files.includes('web.tsx'),
      )
      const entries = facets.map(
        (entry) =>
          // By target, as the server facet loads: Vite keeps a URL bound to the file it first resolved to.
          `${JSON.stringify(join(entry.path, 'web.tsx'))}: () => import(${JSON.stringify('/@fs/' + join(entry.target, 'web.tsx'))})`,
      )
      return `export const loaders = {${entries.join(',')}};`
    },
    hotUpdate({ file, modules, type }) {
      if (
        this.environment.name !== 'client' ||
        type !== 'create' ||
        !roots.some((root) => file.startsWith(root + '/'))
      )
        return undefined
      const styles = this.environment.moduleGraph.getModuleById(
        join(ultimateRoot, 'web/src/index.css'),
      )
      return styles && !modules.includes(styles) ? [...modules, styles] : undefined
    },
    configureServer(server) {
      server.watcher.add([...roots, ...settingsFiles])
      const structure = (file: string) => {
        if (
          !settingsFiles.includes(file) &&
          !roots.some((root) => file === root || file.startsWith(root + '/'))
        )
          return
        for (const id of [resolved, join(ultimateRoot, 'web/src/index.css')]) {
          const module = server.moduleGraph.getModuleById(id)
          if (module) {
            server.moduleGraph.invalidateModule(module)
            void server
              .reloadModule(module)
              .catch((error: unknown) => console.error(`Reloading ${id} failed:`, error))
          }
        }
      }
      const stopRoots = watchRoots([...roots, ...settingsFiles], (root) => {
        server.watcher.add(root)
        structure(root)
      })
      const settingsChanged = (file: string) => {
        if (settingsFiles.includes(file)) structure(file)
      }
      server.watcher.on('change', settingsChanged)
      for (const event of ['add', 'unlink', 'addDir', 'unlinkDir'] as const)
        server.watcher.on(event, structure)
      const stopWatching = () => {
        stopRoots()
        server.watcher.off('change', settingsChanged)
        for (const event of ['add', 'unlink', 'addDir', 'unlinkDir'] as const)
          server.watcher.off(event, structure)
      }
      // During restart the replacement configures before the old environments close.
      watchers.set(server.environments.client, stopWatching)
      server.httpServer?.once('close', stopWatching)
    },
  }
}
