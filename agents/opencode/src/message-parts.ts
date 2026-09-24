// The normalized part shape the presentation layer reads. OpenCode's own message content is
// converted into it once, in message-history.ts, so nothing past that converter names an
// OpenCode type. Native payloads can omit fields declared here as required; readers that
// depend on one still guard it.

interface PartBase {
  id: string
  sessionID: string
  messageID: string
}

export interface TextPart extends PartBase {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
}

export interface ReasoningPart extends PartBase {
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
}

export interface FilePart extends PartBase {
  type: "file"
  mime: string
  filename?: string
  url: string
}

type ToolInput = Record<string, unknown>
type ToolMetadata = Record<string, unknown>

export type ToolState =
  | { status: "pending"; input: ToolInput }
  | { status: "running"; input: ToolInput; title?: string; metadata?: ToolMetadata; time: { start: number } }
  | { status: "completed"; input: ToolInput; output: string; title: string; metadata: ToolMetadata;
      time: { start: number; end: number } }
  | { status: "error"; input: ToolInput; error: string; metadata?: ToolMetadata; time: { start: number; end: number } }

export interface ToolPart extends PartBase {
  type: "tool"
  callID: string
  tool: string
  state: ToolState
}

export type Part = TextPart | ReasoningPart | FilePart | ToolPart
