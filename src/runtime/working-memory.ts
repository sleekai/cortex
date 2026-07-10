import { type Artifact } from '../artifact/artifacts.js'
import { type BudgetConfig } from '../core/types.js'
import { type Plan } from '../capability/planner.js'
import { type CostLedger, emptyCostLedger } from './cost-engine.js'
import { type Task } from './task.js'

export interface WorkingMemory {
  task: Task
  compressedContext: string[]
  plan?: Plan
  artifacts: Artifact[]
  evaluationHistory: Artifact<'evaluation'>[]
  executionHistory: Artifact<'execution'>[]
  budget: BudgetConfig
  tokenUsage: CostLedger
}

export function createWorkingMemory(task: Task, budget: BudgetConfig): WorkingMemory {
  return {
    task,
    compressedContext: [],
    artifacts: [],
    evaluationHistory: [],
    executionHistory: [],
    budget,
    tokenUsage: emptyCostLedger(budget),
  }
}

export function rememberArtifact(memory: WorkingMemory, artifact: Artifact): WorkingMemory {
  return {
    ...memory,
    artifacts: [...memory.artifacts, artifact],
    evaluationHistory: artifact.kind === 'evaluation'
      ? [...memory.evaluationHistory, artifact as Artifact<'evaluation'>]
      : memory.evaluationHistory,
    executionHistory: artifact.kind === 'execution'
      ? [...memory.executionHistory, artifact as Artifact<'execution'>]
      : memory.executionHistory,
  }
}

