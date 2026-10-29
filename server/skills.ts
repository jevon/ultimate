import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { useProjectSetup } from './project-setup.ts'
import { loadSkills, stripFrontmatter } from '@earendil-works/pi-coding-agent'
import type { Skill } from '@earendil-works/pi-coding-agent'

export type SkillScope = 'clone' | 'user' | 'project'

/** A loaded skill with where it came from, and the paths of same-named skills it overrides in earlier scopes. */
export type ScopedSkill = Skill & { scope: SkillScope; overrides: string[] }

/**
 * Skills from the clone, the project's `.pi/skills`, `~/.ultimate/skills` and, once the project is trusted,
 * `<project>/.ultimate/skills`. A later scope overrides an earlier skill of the same name (Pi keeps the first;
 * Ultimate lets the project override the user and the user the clone). Diagnostics are Pi's, per file.
 */
export function projectSkills(
  host: { ultimateRoot: string; projectRoot: string; userHome: string },
  cwd = host.projectRoot,
) {
  // A project's `.agents/skills` (the Agent Skills folder other tools share) loads with its `.ultimate/skills`, once the
  // project is trusted. The personal `~/.agents/skills` does not: personal skills for Ultimate live in
  // `~/.ultimate/skills`.
  const trusted = useProjectSetup(host.projectRoot, host.userHome)
  const layers: [string, SkillScope][] = [
    [join(host.ultimateRoot, 'skills'), 'clone'],
    [join(cwd, '.pi/skills'), 'project'],
    [join(host.userHome, '.ultimate/skills'), 'user'],
    ...(trusted
      ? ([
          [join(host.projectRoot, '.agents/skills'), 'project'],
          [join(host.projectRoot, '.ultimate/skills'), 'project'],
        ] as [string, SkillScope][])
      : []),
  ]
  const agentDir = join(host.userHome, '.ultimate')
  // A project skill behind a symlink (`.ultimate/skills` → `.agents/skills`) is listed by its real path in the repo,
  // inside `cwd` when the work checkout has it: a git-ignored `.ultimate/` is not there.
  const project = realpathSync(host.projectRoot)
  const located = (skill: Skill): Skill => {
    const path = relative(project, realpathSync(skill.filePath))
    if (path.startsWith('..') || isAbsolute(path)) return skill
    const inCwd = join(cwd, path)
    const filePath = existsSync(inCwd) ? inCwd : join(host.projectRoot, path)
    return { ...skill, filePath, baseDir: dirname(filePath) }
  }
  const byName = new Map<string, ScopedSkill>()
  const diagnostics = []
  // Most folders don't exist; Pi warns about each missing one, which says nothing here.
  for (const [path, scope] of layers.filter(([folder]) => existsSync(folder))) {
    const loaded = loadSkills({ cwd, agentDir, skillPaths: [path], includeDefaults: false })
    diagnostics.push(...loaded.diagnostics)
    for (const skill of loaded.skills.map(located)) {
      const earlier = byName.get(skill.name)
      // Both of a symlinked pair load the same file: it overrides nothing.
      const overridden = earlier && earlier.filePath !== skill.filePath ? [earlier.filePath] : []
      // Map order is first insertion: delete so the winner lists where its own scope puts it.
      byName.delete(skill.name)
      byName.set(skill.name, {
        ...skill,
        scope,
        overrides: [...(earlier?.overrides ?? []), ...overridden],
      })
    }
  }
  return { skills: [...byName.values()], diagnostics }
}

/**
 * `/skill:name args` as Pi's AgentSession expands it: the skill's body in a `<skill>` block, then the arguments as the
 * request. Any other text, or an unknown skill, comes back as it was.
 */
export function expandSkillCommand(text: string, skills: readonly Skill[]) {
  // Pi upstream: @earendil-works/pi-coding-agent@1.4.0 src/core/agent-session.ts _expandSkillCommand — copied block format. Drop when Pi exports the expansion.
  const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const skill = match && skills.find((candidate) => candidate.name === match[1])
  if (!match || !skill) return text
  const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim()
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  const args = match[2]?.trim()
  return args ? `${block}\n\n${args}` : block
}
