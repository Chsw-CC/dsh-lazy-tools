/** On-demand tool and skill access for DeepSeek Harness. */

export interface Config {
  /** Model-facing tool name (default "toolbox"). */
  toolName?: string
  /**
   * Tools that stay eager and native beside the toolbox. `*` is the only wildcard.
   * Defaults to the core set (read, write, edit, apply_patch, glob, grep, bash, todo_write)
   * filtered to what the registry actually provides. Pass false to defer everything.
   */
  eager?: string[] | false
  /** The earlier name for `eager`; both are read. */
  keep?: string[] | false
  /** Characters of each description kept in a catalog line (default 96). */
  catalogDescriptionChars?: number
  /** Token budget for one listing; the listing degrades instead of overrunning it (default 1200). */
  catalogTokenBudget?: number
  /** Narrow the visible tool surface per agent (default true). */
  hideOthers?: boolean
  /** Include the skill catalog and the `skill` action (default true). */
  skills?: boolean
}

export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: unknown, config?: Config): void
