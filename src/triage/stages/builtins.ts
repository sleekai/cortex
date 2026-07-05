// Side-effect module: registers the built-in CTS stages. Import this once
// before running the pipeline. The pipeline imposes stage order; registration
// order here is irrelevant.
import { registerStage } from '../registry.js'
import { normalizeStage } from './normalize.js'
import { ambiguityStage } from './ambiguity.js'
import { routingStage } from './routing.js'

registerStage(normalizeStage)
registerStage(ambiguityStage)
registerStage(routingStage)
