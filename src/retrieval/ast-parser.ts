import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'
import { type CodeChunk } from '../core/types.js'
import { debug, warn } from '../core/logger.js'

const EXT_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
}

function parseWithTypeScript(filePath: string): ts.SourceFile | null {
  const ext = path.extname(filePath)
  if (!EXT_MAP[ext]) {
    return null
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  } catch {
    debug(`ast: cannot read ${filePath} — excluded from retrieval`)
    return null
  }
}

function extractChunks(sourceFile: ts.SourceFile, filePath: string): CodeChunk[] {
  const chunks: CodeChunk[] = []

  function addChunk(name: string, node: ts.Node, kind: CodeChunk['kind']) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
    const fullText = node.getFullText(sourceFile)
    const firstLine = fullText.split('\n')[0]!.trim()
    chunks.push({
      file: filePath,
      name,
      kind,
      source: fullText,
      startLine: start,
      endLine: end,
      signature: firstLine,
      score: 0,
    })
  }

  function walk(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addChunk(node.name.text, node, 'function')
    } else if (ts.isClassDeclaration(node) && node.name) {
      addChunk(node.name.text, node, 'class')
      node.forEachChild((member) => {
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && ts.isIdentifier(member.name)) {
          addChunk(`${node.name!.text}.${member.name.text}`, member, 'method')
        }
      })
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      addChunk(node.name.text, node, 'interface')
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      addChunk(node.name.text, node, 'type')
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          addChunk(decl.name.text, decl, 'function')
        }
      }
    }
    ts.forEachChild(node, walk)
  }

  walk(sourceFile)
  return chunks
}

export function parseFile(filePath: string): CodeChunk[] {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    warn(`file not found: ${resolved}`)
    return []
  }

  const sf = parseWithTypeScript(resolved)
  if (!sf) {
    debug(`skipped (unsupported extension): ${resolved}`)
    return []
  }

  const chunks = extractChunks(sf, resolved)
  debug(`${resolved}: ${chunks.length} chunks`)
  return chunks
}

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'dist-test', 'build', 'out', 'coverage',
  'vendor', 'target', '__pycache__',
])

export function findSourceFiles(rootDir: string, maxFiles = 50): string[] {
  const results: string[] = []

  function walk(dir: string) {
    if (results.length >= maxFiles) return
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (results.length >= maxFiles) return
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)) {
            walk(full)
          }
        } else if (entry.isFile() && EXT_MAP[path.extname(entry.name)]) {
          results.push(full)
        }
      }
    } catch { /* permission denied or missing */ }
  }

  walk(rootDir)
  return results
}

export function parseDirectory(rootDir: string, maxFiles = 50): CodeChunk[] {
  const files = findSourceFiles(rootDir, maxFiles)
  const all: CodeChunk[] = []
  for (const file of files) {
    all.push(...parseFile(file))
  }
  return all
}
