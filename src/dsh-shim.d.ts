// Build-time declarations only. At runtime, DeepSeek Harness supplies these
// peer dependencies from its profile; bundling a second copy breaks its tool
// registry singleton.
declare module '@deepseek-ai/cordis' {
  export interface Context {
    /** Optional-service read; every lookup is narrowed by the caller. */
    get(name: string): unknown
    tools: {
      register(definition: unknown): void
    }
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool<T>(definition: T): T
}
