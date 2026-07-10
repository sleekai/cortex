import * as fs from 'node:fs'
import * as path from 'node:path'
import { type ArtifactPrimitive } from '../primitives/primitives.js'
import { type TaskId, type ArtifactId } from '../primitives/ids.js'
import { type Result, ok, err } from '../primitives/errors.js'
import { deserialize, serialize } from '../primitives/serialize.js'

export interface ArtifactStore {
  save(artifact: ArtifactPrimitive): Promise<void>
  load(id: ArtifactId): Promise<ArtifactPrimitive | null>
  list(taskId: TaskId): Promise<ArtifactPrimitive[]>
  delete(id: ArtifactId): Promise<void>
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactPrimitive>()

  async save(artifact: ArtifactPrimitive): Promise<void> {
    this.artifacts.set(artifact.id, artifact)
  }

  async load(id: ArtifactId): Promise<ArtifactPrimitive | null> {
    return this.artifacts.get(id) ?? null
  }

  async list(taskId: TaskId): Promise<ArtifactPrimitive[]> {
    return Array.from(this.artifacts.values()).filter(a => a.task === taskId)
  }

  async delete(id: ArtifactId): Promise<void> {
    this.artifacts.delete(id)
  }
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly baseDir: string) {}

  private artifactPath(id: ArtifactId, task?: TaskId): string {
    if (task) {
      return path.join(this.baseDir, '.cortex', 'artifacts', task, `${id}.json`)
    }
    return path.join(this.baseDir, '.cortex', 'artifacts', `${id}.json`)
  }

  async save(artifact: ArtifactPrimitive): Promise<void> {
    const filePath = this.artifactPath(artifact.id as ArtifactId, artifact.task as TaskId)
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const json = serialize(artifact, true)
    fs.writeFileSync(filePath, json, 'utf-8')
  }

  async load(id: ArtifactId): Promise<ArtifactPrimitive | null> {
    const artifactsDir = path.join(this.baseDir, '.cortex', 'artifacts')
    try {
      const tasks = fs.readdirSync(artifactsDir)
      for (const task of tasks) {
        const filePath = path.join(artifactsDir, task, `${id}.json`)
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          const result = deserialize(content)
          if (result.ok) return result.value as ArtifactPrimitive
        } catch {
          continue
        }
      }
    } catch {
      // artifacts directory doesn't exist yet
    }
    return null
  }

  async list(taskId: TaskId): Promise<ArtifactPrimitive[]> {
    const dir = path.join(this.baseDir, '.cortex', 'artifacts', taskId)
    try {
      const entries = fs.readdirSync(dir)
      const results: ArtifactPrimitive[] = []
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue
        const content = fs.readFileSync(path.join(dir, entry), 'utf-8')
        const result = deserialize(content)
        if (result.ok && result.value.kind === 'artifact') {
          results.push(result.value as ArtifactPrimitive)
        }
      }
      return results
    } catch {
      return []
    }
  }

  async delete(id: ArtifactId): Promise<void> {
    const filePath = path.join(this.baseDir, '.cortex', 'artifacts', `${id}.json`)
    try {
      fs.unlinkSync(filePath)
    } catch {
      // not found is fine
    }
  }
}
