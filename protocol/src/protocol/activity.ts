import { z } from "zod"
import { ACTIVITY_KINDS, ACTIVITY_STATES } from "./activity.generated.js"
export { ACTIVITY_KINDS, ACTIVITY_STATES }
export const activitySchema = z.object({ kind: z.enum(ACTIVITY_KINDS), state: z.enum(ACTIVITY_STATES) }).strict()
export type Activity = z.infer<typeof activitySchema>
