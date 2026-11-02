export type Stage = 'checking' | 'waiting' | 'downloading' | 'python' | 'installing' | 'connecting' | 'ready' | 'needs-install' | 'cancelled' | 'error'
export type FailureCode = 'download' | 'integrity' | 'unsupported' | 'install' | 'backend' | 'custom-command' | 'timeout' | 'storage'

export interface BackendState {
  stage: Stage
  source: 'existing' | 'managed' | null
  error: FailureCode | null
  remoteEnabled: boolean
  execEnabled: boolean
}

export class SetupError extends Error {
  constructor(readonly code: FailureCode) {
    super(`dsh-hoploom: backend setup failed (${code}). Open the Hoploom panel to retry or select an existing installation.`)
  }
}

export const activeStages: Stage[] = ['checking', 'waiting', 'downloading', 'python', 'installing', 'connecting']
export const API_ROUTE = 'api/dsh-hoploom/backend'
