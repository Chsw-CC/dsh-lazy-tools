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
  /** Hide every other tool per agent (`false` only adds the toolbox and narrows nothing). */
  hideOthers?: boolean
  /** Include the skill catalog and the `skill` action (default true). */
  skills?: boolean
}

export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: unknown, config?: Config): void
