// Side-effect module: registers the built-in CTS skills. Import this once
// before running the pipeline. The pipeline imposes stage order; registration
// order here is irrelevant.
import { registerSkill } from '../registry.js'
import { normalizeSkill } from './normalize.js'
import { ambiguitySkill } from './ambiguity.js'
import { routingSkill } from './routing.js'

registerSkill(normalizeSkill)
registerSkill(ambiguitySkill)
registerSkill(routingSkill)
