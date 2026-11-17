/** On-demand tool and skill access for DeepSeek Harness. */

export interface Config {
  /** Model-facing tool name (default "toolbox"). */
  toolName?: string
  /** Tools that stay visible next to the toolbox. `*` is the only wildcard, e.g. `read_*`. */
  keep?: string[]
  /** Characters of each description kept in a catalog line (default 96). */
  catalogDescriptionChars?: number
  /** Token budget for one catalog listing; the listing degrades instead of overrunning it (default 1200). */
  catalogTokenBudget?: number
  /** Characters of each parameter signature kept in a catalog line (default 64). */
  catalogSignatureChars?: number
  /** Render a compact parameter signature per tool in a listing (default true). Set false for name-only rows. */
  signatures?: boolean
  /** How many query-matched tools get their full schema inlined into one listing (default 3; 0 disables). */
  listSchemaLimit?: number
  /** Repeat a tool's exact schema when a call's arguments are rejected (default true). */
  autoSchema?: boolean
  /** Hide every other tool per agent (`false` only adds the toolbox and narrows nothing). */
  hideOthers?: boolean
  /** Include the skill catalog and the `skill` action (default true). */
  skills?: boolean
}

export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: unknown, config?: Config): void
