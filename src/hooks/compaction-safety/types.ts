export interface ChatParamsInput {
  sessionID: string
  agent: { name?: string }
  model: { providerID: string; modelID: string }
}

export interface ChatParamsOutput {
  temperature?: number
  topP?: number
  topK?: number
  maxTokens?: number
  options: Record<string, unknown>
}
