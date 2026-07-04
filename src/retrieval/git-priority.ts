import { execSync } from 'node:child_process'
import { debug } from '../core/logger.js'

export function prioritizeRecent(projectRoot: string): Set<string> {
  const recent = new Set<string>()

  try {
    const log = execSync('git log --name-only --pretty=format: -n 15', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const lines = log.split('\n').map(l => l.trim()).filter(Boolean)
    for (const line of lines) {
      recent.add(line)
    }

    debug(`git priority: ${recent.size} recently changed files`)
  } catch {
    debug('git priority: not a git repo or git unavailable')
  }

  return recent
}
