import type { AnsweredQuestionBatch } from "../chat-message.js";

// Remembers a resolved question batch by session, keyed independently of any live
// subscription so it survives a reconnect (unlike LiveParts, which is recreated per
// subscription). Process-lifetime only -- lost on a plugin/OpenCode restart. Bounded on
// both dimensions so a long-running process serving many sessions never grows
// unbounded. See ADR 0011, "Update: a persisted asked/answered record".
export class AnsweredQuestionMemory {
  readonly #answered = new Map<string, AnsweredQuestionBatch[]>();

  record(sessionId: string, batch: AnsweredQuestionBatch): void {
    const existing = this.#answered.get(sessionId);
    if (existing) {
      existing.push(batch);
      if (existing.length > 20) existing.shift();
      return;
    }
    if (this.#answered.size >= 200) {
      const oldest = this.#answered.keys().next().value;
      if (oldest !== undefined) this.#answered.delete(oldest);
    }
    this.#answered.set(sessionId, [batch]);
  }

  get(sessionId: string): readonly AnsweredQuestionBatch[] {
    return this.#answered.get(sessionId) ?? [];
  }
}
