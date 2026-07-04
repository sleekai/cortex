#!/usr/bin/env node

/**
 * cortex-install-skill
 *
 * Installs the cortex skill (SKILL.md + MCP server) into supported AI
 * coding harnesses: opencode, Claude Code, Claude Desktop, and generic
 * agent directories.
 *
 * Usage:
 *   node skills/install.js                        # auto-detect & install
 *   node skills/install.js --target opencode      # specific target
 *   node skills/install.js --target claude,agents  # comma-separated
 *   node skills/install.js --dry-run              # preview only
 *   node skills/install.js --help                 # show help
 *
 * Published as `cortex-install-skill` bin so it can be invoked via:
 *   npx -y --package=@sleekai/cortex@latest -- cortex-install-skill
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

// ─── Paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const SKILLS_DIR = path.resolve(path.dirname(__filename))
const PACKAGE_ROOT = path.resolve(SKILLS_DIR, '..')
const SKILL_SRC = path.join(SKILLS_DIR, 'cortex')

const HARNESS_TARGETS = {
  opencode: {
    name: 'opencode',
    skillDir: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return path.join(home, '.config', 'opencode', 'skills', 'cortex')
    },
    info: '~/.config/opencode/skills/cortex/',
    detect: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return fs.existsSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'))
    },
  },
  claude: {
    name: 'Claude Code',
    skillDir: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return path.join(home, '.claude', 'skills', 'cortex')
    },
    info: '~/.claude/skills/cortex/',
    detect: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return fs.existsSync(path.join(home, '.claude'))
    },
  },
  agents: {
    name: 'agent skills (generic)',
    skillDir: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return path.join(home, '.agents', 'skills', 'cortex')
    },
    info: '~/.agents/skills/cortex/',
    detect: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return fs.existsSync(path.join(home, '.agents'))
    },
  },
}

const MCP_TARGETS = {
  'claude-desktop': {
    name: 'Claude Desktop',
    configPath: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    },
    detect: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return fs.existsSync(path.join(home, 'Library', 'Application Support', 'Claude'))
    },
  },
  opencode: {
    name: 'opencode',
    configPath: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return path.join(home, '.config', 'opencode', 'opencode.jsonc')
    },
    detect: () => {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return fs.existsSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'))
    },
  },
}

// ─── Help ─────────────────────────────────────────────────────────────

const HELP = `cortex-install-skill — install cortex skill + MCP server into AI coding harnesses

USAGE
  node skills/install.js [options]

OPTIONS
  --target <list>    Comma-separated harness targets (opencode, claude, agents).
                     Default: all detected.
  --dry-run          Preview what would be installed without writing anything.
  --help, -h         Show this help.

EXAMPLES
  node skills/install.js                          # auto-detect & install all
  node skills/install.js --target opencode        # opencode only
  node skills/install.js --target claude,agents   # Claude Code + agents
  node skills/install.js --dry-run                # preview only
`

// ─── Utils ────────────────────────────────────────────────────────────

function log(...args) {
  process.stdout.write(`  ${args.join(' ')}\n`)
}

function ok(label, msg) {
  process.stdout.write(`  ✔  ${label}: ${msg}\n`)
}

function skip(label, msg) {
  process.stdout.write(`  ·  ${label}: ${msg}\n`)
}

function fail(label, msg) {
  process.stdout.write(`  ✖  ${label}: ${msg}\n`)
}

function section(title) {
  process.stdout.write(`\n  ${title}\n${'  ' + '─'.repeat(title.length)}\n`)
}

function copyDir(src, dest) {
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true })
  }
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry)
    const dstPath = path.join(dest, entry)
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, dstPath)
    }
  }
}

function whichBin(bin) {
  try {
    execSync(`command -v ${bin}`, { stdio: 'pipe', encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

// ─── Installers ────────────────────────────────────────────────────────

function installSkill(opts) {
  const { dryRun, targets } = opts
  section('Installing cortex skill')

  if (!fs.existsSync(SKILL_SRC)) {
    fail('source', `skill directory not found at ${SKILL_SRC}`)
    return
  }

  for (const [key, harness] of Object.entries(HARNESS_TARGETS)) {
    if (targets && !targets.includes(key)) {
      skip(harness.name, 'not requested')
      continue
    }

    if (!harness.detect()) {
      skip(harness.name, 'not detected')
      continue
    }

    const dest = harness.skillDir()
    if (dryRun) {
      log(`  would copy ${SKILL_SRC} -> ${dest}`)
      continue
    }

    copyDir(SKILL_SRC, dest)
    ok(harness.name, `installed at ${harness.info}`)
  }
}

function installMCP(opts) {
  const { dryRun } = opts
  section('Installing cortex MCP server')

  const cortexOnPath = whichBin('cortex-mcp')
  if (!cortexOnPath) {
    log('  ⚠  cortex-mcp not found on PATH. MCP config will reference the binary')
    log('     but you may need to run the script from within the cortex package,')
    log('     or install cortex globally: npm install -g @sleekai/cortex')
  }

  const mcpEntry = {
    command: 'cortex-mcp',
    args: [],
  }

  // ── Claude Desktop ──
  {
    const target = MCP_TARGETS['claude-desktop']
    if (target.detect()) {
      const configPath = target.configPath()
      let config = {}
      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        } catch {
          fail(target.name, `could not parse ${configPath}`)
        }
      }

      if (dryRun) {
        log(`  would add cortex MCP entry to ${configPath}`)
      } else {
        const mcpServers = config.mcpServers || {}
        if (mcpServers.cortex) {
          skip(target.name, 'cortex MCP entry already exists')
        } else {
          mcpServers.cortex = { ...mcpEntry }
          config.mcpServers = mcpServers
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
          ok(target.name, `added MCP entry to ${configPath}`)
        }
      }
    } else {
      skip(target.name, 'not detected')
    }
  }

  // ── opencode ──
  {
    const target = MCP_TARGETS.opencode
    if (target.detect()) {
      const configPath = target.configPath()
      let content = ''
      if (fs.existsSync(configPath)) {
        content = fs.readFileSync(configPath, 'utf-8')
      }

      // Check if cortex MCP entry already exists
      const hasCortexEntry = (content.includes('"cortex"') && (content.includes('"command"') || content.includes('"url"')))
      if (hasCortexEntry) {
        skip(target.name, 'cortex MCP entry already exists')
      } else if (dryRun) {
        log(`  would add cortex MCP entry to ${configPath}`)
      } else {
        // Parse the JSONC-like config and merge into the "mcp" section
        try {
          const config = JSON.parse(content)
          const mcp = config.mcp || {}
          mcp.cortex = { command: 'cortex-mcp', args: [] }
          config.mcp = mcp
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
          ok(target.name, `added cortex MCP entry to ${configPath}`)
        } catch {
          // If JSON parse fails (e.g. trailing commas in JSONC), fall back to text insertion
          const mcpBlock = `\n  "mcp": {\n    "cortex": {\n      "command": "cortex-mcp",\n      "args": []\n    }\n  }`
          content = content.trimEnd()
          if (content.endsWith('}')) {
            const lastBrace = content.lastIndexOf('}')
            if (lastBrace > 0) {
              const before = content.slice(0, lastBrace).trimEnd()
              content = (before.endsWith(',') ? before : before + ',') + mcpBlock + '\n}'
            }
          }
          fs.writeFileSync(configPath, content, 'utf-8')
          ok(target.name, `added cortex MCP entry to ${configPath}`)
        }
      }
    } else {
      skip(target.name, 'not detected')
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────

function printSummary() {
  section('Post-install')

  if (!whichBin('cortex-mcp')) {
    log('  ⚠  cortex-mcp not on PATH. Make sure cortex is installed globally')
    log('     or run this script from within the cortex package directory.')
    log('')
  }

  log('  Next steps:')
  log('')
  log('  • Restart your harness (opencode, Claude Code, etc.) to pick up')
  log('    the new skill and MCP server.')
  log('')
  log('  • Test the MCP connection:')
  log('      echo \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\' | cortex-mcp')
  log('')
  log('  • Verify the skill is loadable by invoking /cortex in your harness.')
  log('')
}

// ─── CLI ──────────────────────────────────────────────────────────────

function parseArgs(raw) {
  const args = { dryRun: false, targets: null }
  for (let i = 2; i < raw.length; i++) {
    const arg = raw[i]
    if (arg === '--help' || arg === '-h') {
      console.log(HELP)
      process.exit(0)
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--target' && i + 1 < raw.length) {
      args.targets = raw[++i].split(',').map(s => s.trim()).filter(Boolean)
    }
  }
  return args
}

function main() {
  const opts = parseArgs(process.argv)

  process.stdout.write(`
  ╔══════════════════════════════════════╗
  ║   cortex-install-skill              ║
  ║   AI Compute OS — skill installer   ║
  ╚══════════════════════════════════════╝
`)

  const validTargets = Object.keys(HARNESS_TARGETS)
  if (opts.targets) {
    const invalid = opts.targets.filter(t => !validTargets.includes(t))
    if (invalid.length > 0) {
      process.stderr.write(`  error: unknown target(s): ${invalid.join(', ')}\n`)
      process.stderr.write(`  valid targets: ${validTargets.join(', ')}\n`)
      process.exit(1)
    }
  }

  if (opts.dryRun) {
    log('  DRY RUN — no files will be written\n')
  }

  installSkill(opts)
  installMCP(opts)
  printSummary()
}

main()
