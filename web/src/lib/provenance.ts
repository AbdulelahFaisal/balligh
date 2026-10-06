import type { GenerationInfo, LessonDraft, LiveGeneration } from "./types";

export const isLive = (g: GenerationInfo): g is LiveGeneration => g.origin === "live";

export function markHumanEdit(draft: LessonDraft, at: string = new Date().toISOString()): LessonDraft {
  return { ...draft, generation: { ...draft.generation, human_edited: true, last_human_edit_at: at } as GenerationInfo };
}

export interface GenerationTicket {
  opId: number;
  revision: number;
}

export function canApplyResult(ticket: GenerationTicket, currentOpId: number, currentRevision: number, aborted: boolean) {
  return !aborted && ticket.opId === currentOpId && ticket.revision === currentRevision;
}
