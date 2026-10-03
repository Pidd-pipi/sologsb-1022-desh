import { clone } from './editor';
import type { Annotation, Chapter, TextDocument } from './types';

export type Role = 'principal' | 'editor';

export const ROLE_LABELS: Record<Role, string> = {
  principal: '主校',
  editor: '整理者'
};

/** 增量提交操作：只描述本章内的改动 */
export type CommitOp =
  | { type: 'body'; sentenceId: string; text: string }
  | { type: 'annotation-add'; annotation: Annotation }
  | { type: 'annotation-update'; annotation: Annotation }
  | { type: 'annotation-delete'; annotationId: string };

export interface ConflictDetail {
  opIndex: number;
  kind: 'body' | 'annotation-update' | 'annotation-delete';
  targetId: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  conflictingFields?: string[];
}

export type PendingCommitStatus = 'pending' | 'conflict' | 'rejected' | 'error';

export interface PendingCommit {
  commitId: string;
  chapterId: string;
  label: string;
  ops: CommitOp[];
  baseVersion: number;
  createdAt: string;
  status: PendingCommitStatus;
  conflicts?: ConflictDetail[];
  message?: string;
  /** 主校裁决后的终局提交：直接应用裁决结果 */
  force?: boolean;
}

export const ROLE_STORAGE_KEY = 'sologsb-1022/public-text-annotator/role/v1';
export const PENDING_STORAGE_KEY = 'sologsb-1022/public-text-annotator/pending/v1';

/** 归属于某章的注释：章节级、句级、词级（含已降级到句的词级注释） */
export function chapterAnnotations(document: TextDocument, chapter: Chapter): Annotation[] {
  const sentenceIds = new Set(chapter.sentences.map((sentence) => sentence.id));
  const tokenIds = new Set(chapter.sentences.flatMap((sentence) => sentence.tokens.map((token) => token.id)));
  return document.annotations.filter((annotation) => {
    if (annotation.anchorType === 'chapter') return annotation.anchorId === chapter.id;
    if (annotation.anchorType === 'sentence') return sentenceIds.has(annotation.anchorId);
    return tokenIds.has(annotation.anchorId);
  });
}

/** 对比基线与本地草稿，生成章节增量操作 */
export function diffChapterOps(
  baseChapter: Chapter,
  baseAnnotations: Annotation[],
  localChapter: Chapter,
  localAnnotations: Annotation[]
): CommitOp[] {
  const ops: CommitOp[] = [];

  for (const sentence of localChapter.sentences) {
    const base = baseChapter.sentences.find((item) => item.id === sentence.id);
    if (base && base.text !== sentence.text) {
      ops.push({ type: 'body', sentenceId: sentence.id, text: sentence.text });
    }
  }

  const baseIds = new Set(baseAnnotations.map((item) => item.id));
  const localIds = new Set(localAnnotations.map((item) => item.id));
  for (const annotation of localAnnotations) {
    if (!baseIds.has(annotation.id)) {
      ops.push({ type: 'annotation-add', annotation: clone(annotation) });
    } else {
      const base = baseAnnotations.find((item) => item.id === annotation.id);
      if (base && JSON.stringify(base) !== JSON.stringify(annotation)) {
        ops.push({ type: 'annotation-update', annotation: clone(annotation) });
      }
    }
  }
  for (const annotation of baseAnnotations) {
    if (!localIds.has(annotation.id)) {
      ops.push({ type: 'annotation-delete', annotationId: annotation.id });
    }
  }

  return ops;
}

export function loadRole(): Role {
  try {
    const raw = localStorage.getItem(ROLE_STORAGE_KEY);
    if (raw === 'principal' || raw === 'editor') return raw;
  } catch {
    /* 隐私模式等场景下退回默认角色 */
  }
  return 'editor';
}

export function saveRole(role: Role) {
  try {
    localStorage.setItem(ROLE_STORAGE_KEY, role);
  } catch {
    /* 忽略持久化失败 */
  }
}

export function loadPendingCommits(): PendingCommit[] {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PendingCommit[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* 损坏则丢弃待办 */
  }
  return [];
}

export function savePendingCommits(commits: PendingCommit[]) {
  try {
    localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(commits));
  } catch {
    /* 忽略持久化失败 */
  }
}
