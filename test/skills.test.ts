import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { expandSkillCommand, projectSkills } from '../server/skills.ts'
import { skillInfo } from '../server/system.ts'
import { removeTemp, temp } from './helpers.ts'

let home: string
afterEach(() => removeTemp(home))

async function skill(path: string, frontmatter: string, body = 'Do the thing.') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `---\n${frontmatter}\n---\n${body}\n`)
}

async function setup() {
  home = await temp()
  const host = {
    ultimateRoot: join(home, 'clone'),
    projectRoot: join(home, 'project'),
    userHome: join(home, 'user'),
  }
  await mkdir(host.projectRoot, { recursive: true })
  await skill(
    join(host.ultimateRoot, 'skills/ship/SKILL.md'),
    'name: ship\ndescription: Clone ship',
  )
  await skill(
    join(host.userHome, '.ultimate/skills/ship/SKILL.md'),
    'name: ship\ndescription: User ship',
  )
  // The personal Agent Skills folder belongs to other agents and is never read.
  await skill(
    join(host.userHome, '.agents/skills/shared/SKILL.md'),
    'name: shared\ndescription: Personal Agent Skills folder',
  )
  await skill(
    join(host.projectRoot, '.agents/skills/team/SKILL.md'),
    'name: team\ndescription: Team skill\ndisable-model-invocation: true',
  )
  await skill(join(host.projectRoot, '.ultimate/skills/broken/SKILL.md'), 'name: broken')
  return host
}

it('loads every scope, lets later scopes override and keeps Pi diagnostics', async () => {
  const host = await setup()
  const untrusted = skillInfo(projectSkills(host))
  // The project's .agents and .ultimate skills wait for the project to be trusted.
  expect(untrusted.skills.map((s) => [s.name, s.scope, s.description])).toEqual([
    ['ship', 'user', 'User ship'],
  ])
  expect(untrusted.skills[0]?.overrides).toEqual([join(host.ultimateRoot, 'skills/ship/SKILL.md')])
  expect(untrusted.skillDiagnostics).toEqual([])

  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, true)
  const trusted = skillInfo(projectSkills(host))
  expect(trusted.skills.find((s) => s.name === 'team')).toMatchObject({
    scope: 'project',
    manual: true,
  })
  expect(trusted.skills.some((s) => s.name === 'broken' || s.name === 'shared')).toBe(false)
  expect(trusted.skillDiagnostics).toEqual([
    {
      type: 'warning',
      message: 'description is required',
      path: join(host.projectRoot, '.ultimate/skills/broken/SKILL.md'),
    },
  ])
})

it('lists a skill behind a symlinked .ultimate/skills by its real path in the work checkout', async () => {
  home = await temp()
  const host = {
    ultimateRoot: join(home, 'clone'),
    projectRoot: join(home, 'project'),
    userHome: join(home, 'user'),
  }
  const worktree = join(home, 'worktree')
  const file = '.agents/skills/shots/SKILL.md'
  await skill(join(host.projectRoot, file), 'name: shots\ndescription: Screenshots')
  await mkdir(join(host.projectRoot, '.ultimate'))
  await symlink('../.agents/skills', join(host.projectRoot, '.ultimate/skills'))
  // The work checkout has the tracked `.agents/skills`, not the git-ignored `.ultimate/`.
  await skill(join(worktree, file), 'name: shots\ndescription: Screenshots')
  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, true)

  const [shots] = projectSkills(host, worktree).skills
  expect(shots).toMatchObject({ filePath: join(worktree, file), overrides: [] })
  expect(projectSkills(host).skills[0]?.filePath).toBe(join(host.projectRoot, file))
})

it('expands /skill:name args as Pi does and leaves anything else alone', async () => {
  const host = await setup()
  const { skills } = projectSkills(host)
  const path = join(host.userHome, '.ultimate/skills/ship/SKILL.md')
  expect(expandSkillCommand('/skill:ship  to staging ', skills)).toBe(
    `<skill name="ship" location="${path}">\nReferences are relative to ${dirname(path)}.\n\nDo the thing.\n</skill>\n\nto staging`,
  )
  expect(expandSkillCommand('/skill:ship', skills)).toMatch(/<\/skill>$/)
  expect(expandSkillCommand('/skill:unknown go', skills)).toBe('/skill:unknown go')
  expect(expandSkillCommand('please /skill:ship', skills)).toBe('please /skill:ship')
})
