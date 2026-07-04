// Common harness templates — turn a one-liner into a full WorkerSpec.

import { type WorkerSpec, type WorkerTier, type WriteAccess } from './registry.js'
import { type Capability } from '../capability/capabilities.js'

export interface TemplateArgs {
  id: string
  tier?: WorkerTier
  writeAccess?: WriteAccess
  capabilities?: Capability[]
}

// ── OpenAI-compatible HTTP API ──────────────────────────────────────────

export interface OpenAiTemplateArgs extends TemplateArgs {
  apiKey?: string
  model?: string
  baseUrl?: string
}

export function openAiTemplate(args: OpenAiTemplateArgs): WorkerSpec {
  const model = args.model ?? 'gpt-4o'
  const baseUrl = args.baseUrl ?? 'https://api.openai.com/v1'
  const apiKey = args.apiKey ?? process.env['OPENAI_API_KEY'] ?? ''
  return {
    id: args.id,
    capabilities: args.capabilities ?? ['coding', 'reasoning', 'planning'],
    harness: {
      kind: 'http',
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      bodyTemplate: {
        model,
        messages: [{ role: 'user', content: '{{prompt}}' }],
        max_tokens: 4096,
      },
      outputPath: 'choices.0.message.content',
    },
    cost: { inPer1k: 2.5, outPer1k: 10 },
    speed: 0.6,
    contextWindow: 128000,
    quality: { coding: 0.85, reasoning: 0.88, planning: 0.8 },
    reliability: 0.95,
    tier: args.tier ?? 3,
    writeAccess: args.writeAccess ?? 'patch',
  }
}

// ── Anthropic API ───────────────────────────────────────────────────────

export interface AnthropicTemplateArgs extends TemplateArgs {
  apiKey?: string
  model?: string
}

export function anthropicTemplate(args: AnthropicTemplateArgs): WorkerSpec {
  const model = args.model ?? 'claude-sonnet-4-20250514'
  const apiKey = args.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? ''
  return {
    id: args.id,
    capabilities: args.capabilities ?? ['coding', 'reasoning', 'planning', 'review', 'docs'],
    harness: {
      kind: 'http',
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      bodyTemplate: {
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: '{{prompt}}' }],
      },
      outputPath: 'content.0.text',
    },
    cost: { inPer1k: 3, outPer1k: 15 },
    speed: 0.4,
    contextWindow: 200000,
    quality: { coding: 0.92, reasoning: 0.93, planning: 0.88, review: 0.9, docs: 0.85 },
    reliability: 0.93,
    tier: args.tier ?? 3,
    writeAccess: args.writeAccess ?? 'patch',
  }
}

// ── Ollama (local) ──────────────────────────────────────────────────────

export interface OllamaTemplateArgs extends TemplateArgs {
  model?: string
  baseUrl?: string
}

export function ollamaTemplate(args: OllamaTemplateArgs): WorkerSpec {
  const model = args.model ?? 'llama3.2'
  const baseUrl = args.baseUrl ?? 'http://localhost:11434'
  return {
    id: args.id,
    capabilities: args.capabilities ?? ['coding', 'reasoning'],
    harness: {
      kind: 'http',
      url: `${baseUrl}/api/chat`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model,
        messages: [{ role: 'user', content: '{{prompt}}' }],
        stream: false,
      },
      outputPath: 'message.content',
    },
    cost: { inPer1k: 0, outPer1k: 0 },
    speed: 0.9,
    contextWindow: 8192,
    quality: { coding: 0.6, reasoning: 0.65 },
    reliability: 0.85,
    tier: args.tier ?? 1,
    writeAccess: args.writeAccess ?? 'none',
  }
}

// ── Generic CLI harness ─────────────────────────────────────────────────

export interface CliTemplateArgs extends TemplateArgs {
  bin: string
  args?: string[]
  promptVia?: 'stdin' | 'arg'
  probeArgs?: string[]
  stripEnv?: string[]
  binEnvOverride?: string
  costIn?: number
  costOut?: number
  speed?: number
  contextWindow?: number
}

export function cliTemplate(args: CliTemplateArgs): WorkerSpec {
  return {
    id: args.id,
    capabilities: args.capabilities ?? ['coding', 'reasoning'],
    harness: {
      kind: 'cli',
      bin: args.bin,
      args: args.args ?? [],
      promptVia: args.promptVia ?? 'stdin',
      probeArgs: args.probeArgs ?? ['--version'],
      stripEnv: args.stripEnv ?? [],
      ...(args.binEnvOverride ? { binEnvOverride: args.binEnvOverride } : {}),
    },
    cost: { inPer1k: args.costIn ?? 1, outPer1k: args.costOut ?? 5 },
    speed: args.speed ?? 0.5,
    contextWindow: args.contextWindow ?? 32000,
    quality: { coding: 0.7, reasoning: 0.7 },
    reliability: 0.8,
    tier: args.tier ?? 2,
    writeAccess: args.writeAccess ?? 'patch',
  }
}

// ── Generic HTTP harness ────────────────────────────────────────────────

export interface HttpTemplateArgs extends TemplateArgs {
  url: string
  method?: 'POST'
  headers?: Record<string, string>
  bodyTemplate: unknown
  outputPath: string
  costIn?: number
  costOut?: number
  speed?: number
  contextWindow?: number
}

export function httpTemplate(args: HttpTemplateArgs): WorkerSpec {
  return {
    id: args.id,
    capabilities: args.capabilities ?? ['coding', 'reasoning'],
    harness: {
      kind: 'http',
      url: args.url,
      method: args.method ?? 'POST',
      headers: args.headers ?? { 'Content-Type': 'application/json' },
      bodyTemplate: args.bodyTemplate,
      outputPath: args.outputPath,
    },
    cost: { inPer1k: args.costIn ?? 1, outPer1k: args.costOut ?? 5 },
    speed: args.speed ?? 0.5,
    contextWindow: args.contextWindow ?? 32000,
    quality: { coding: 0.7, reasoning: 0.7 },
    reliability: 0.8,
    tier: args.tier ?? 2,
    writeAccess: args.writeAccess ?? 'patch',
  }
}

// ── Template registry ───────────────────────────────────────────────────

export type TemplateKind =
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'cli'
  | 'http'

export interface TemplateInfo {
  kind: TemplateKind
  label: string
  description: string
}

export const TEMPLATES: TemplateInfo[] = [
  { kind: 'openai', label: 'OpenAI-compatible', description: 'OpenAI API or any OpenAI-compatible endpoint (OpenAI, Groq, Together, etc.)' },
  { kind: 'anthropic', label: 'Anthropic', description: 'Anthropic Messages API (Claude models)' },
  { kind: 'ollama', label: 'Ollama (local)', description: 'Local Ollama instance' },
  { kind: 'cli', label: 'Generic CLI', description: 'Any CLI binary (llamafile, local models, etc.)' },
  { kind: 'http', label: 'Generic HTTP', description: 'Any HTTP API with JSON body/response' },
]
