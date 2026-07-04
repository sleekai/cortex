// Side-effect module: registers the 6 built-in CTS skills. Import this once
// before running the pipeline (mirrors the harness/adapter side-effect imports
// at src/index.ts:9-10). The pipeline imposes stage order; registration order
// here is irrelevant.
import { registerSkill } from '../registry.js'
import { normalizeSkill } from './normalize.js'
import { decomposeSkill } from './decompose.js'
import { ambiguitySkill } from './ambiguity.js'
import { strategySkill } from './strategy.js'
import { routingSkill } from './routing.js'
import { contextFilterSkill } from './context-filter.js'

registerSkill(normalizeSkill)
registerSkill(decomposeSkill)
registerSkill(ambiguitySkill)
registerSkill(strategySkill)
registerSkill(routingSkill)
registerSkill(contextFilterSkill)
