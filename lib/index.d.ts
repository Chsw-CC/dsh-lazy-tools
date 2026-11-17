/** On-demand tool and skill access for DeepSeek Harness. */

export interface Config {
  /** Model-facing tool name (default "toolbox"). */
  toolName?: string
  /** Tool names that stay visible next to the toolbox (default: none). */
  keep?: string[]
  /** Characters of each description kept in a compact catalog line (default 96). */
  catalogDescriptionChars?: number
  /** Hide every other tool per agent (default true). */
  hideOthers?: boolean
  /** Include the skill catalog and the skill loader action (default true). */
  skills?: boolean
}

export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: unknown, config?: Config): void
