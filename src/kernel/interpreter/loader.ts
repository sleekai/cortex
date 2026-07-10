import { type BlueprintPrimitive } from '../primitives/primitives.js'
import { type Result } from '../primitives/errors.js'
import { deserialize } from '../primitives/serialize.js'
import { validateBlueprint } from '../primitives/validate.js'

export interface BlueprintLoader {
  load(source: string | object): Result<BlueprintPrimitive>
  get(id: string): BlueprintPrimitive | undefined
  register(blueprint: BlueprintPrimitive): void
}

export class DefaultBlueprintLoader implements BlueprintLoader {
  private readonly cache = new Map<string, BlueprintPrimitive>()

  load(source: string | object): Result<BlueprintPrimitive> {
    if (typeof source === 'string') {
      const parsed = deserialize(source)
      if (!parsed.ok) return parsed
      source = parsed.value
    }

    const result = validateBlueprint(source)
    if (!result.ok) return result

    this.cache.set(result.value.id, result.value)
    return result
  }

  get(id: string): BlueprintPrimitive | undefined {
    return this.cache.get(id)
  }

  register(blueprint: BlueprintPrimitive): void {
    this.cache.set(blueprint.id, blueprint)
  }
}
