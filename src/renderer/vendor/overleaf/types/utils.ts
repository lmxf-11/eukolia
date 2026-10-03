// Ported verbatim from References/overleaf-main/services/web/types/utils.ts
export type MergeAndOverride<T, U> = Omit<T, keyof U> & U
