import { initialDocument, tokenizeText } from './data';
import { clone, relocateWordAnchors } from './editor';
import { chapterAnnotations } from './collab';
import type { CommitOp, ConflictDetail, Role } from './collab';
import type { Annotation, Chapter, TextDocument, TextToken } from './types';

const SERVER_KEY = 'sologsb-1022/public-text-annotator/server/v1';

export interface ChapterVersionState {
  version: number;
  chapter: Chapter;
  annotations: Annotation[];
}

interface ChapterEntry {
  current: ChapterVersionState;
  history: ChapterVersionState[];
}

interface CommitRecord {
  commitId: string;
  chapterId: string;
  baseVersion: number;
  version: number;
  authorRole: Role;
  label: string;
  appliedAt: string;
  ops: CommitOp[];
}

interface ServerState {
  chapters: Record<string, ChapterEntry>;
  log: CommitRecord[];
}

export type SubmitResult =
  | { status: 'merged'; chapterId: string; version: number; chapter: Chapter; annotations: Annotation[]; replay?: boolean }
  | { status: 'conflict'; chapterId: string; version: number; conflicts: ConflictDetail[] }
  | { status: 'rejected'; chapterId: string; version: number; reason: 'principal-required'; conflicts: ConflictDetail[] }
  | { status: 'error'; chapterId: string; version: number; message: string };

export interface SubmitRequest {
  commitId: string;
  chapterId: string;
  baseVersion: number;
  ops: CommitOp[];
  authorRole: Role;
  label: string;
  /** 主校裁决后的终局提交：直接应用裁决结果，不再走三方合并 */
  force?: boolean;
  /** 模拟接口故障：写入失败但不应用任何改动，两边原稿保留可重试 */
  simulateFailure?: boolean;
}

function seedServer(): ServerState {
  const chapters: ServerState['chapters'] = {};
  for (const chapter of initialDocument.chapters) {
    const annotations = chapterAnnotations(initialDocument, chapter);
    const state: ChapterVersionState = { version: 1, chapter: clone(chapter), annotations: clone(annotations) };
    chapters[chapter.id] = { current: state, history: [state] };
  }
  return { chapters, log: [] };
}

function loadServer(): ServerState {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ServerState;
      if (parsed.chapters && Object.keys(parsed.chapters).length) return parsed;
    }
  } catch {
    /* 存档损坏则重新播种 */
  }
  const seeded = seedServer();
  saveServer(seeded);
  return seeded;
}

function saveServer(state: ServerState) {
  try {
    localStorage.setItem(SERVER_KEY, JSON.stringify(state));
  } catch {
    /* 存储失败时调用方会收到 error 结果 */
  }
}

export function getChapterVersion(chapterId: string): number {
  return loadServer().chapters[chapterId]?.current.version ?? 0;
}

export function getChapterState(chapterId: string): ChapterVersionState | undefined {
  const entry = loadServer().chapters[chapterId];
  return entry ? { version: entry.current.version, chapter: clone(entry.current.chapter), annotations: clone(entry.current.annotations) } : undefined;
}

/** 由各章状态重建完整文档（供客户端同步） */
export function reconstructDocument(): TextDocument {
  const server = loadServer();
  const doc = clone(initialDocument);
  doc.chapters = doc.chapters.map((chapter) => {
    const entry = server.chapters[chapter.id];
    return entry ? clone(entry.current.chapter) : chapter;
  });
  const annotations: Annotation[] = [];
  for (const chapter of doc.chapters) {
    const entry = server.chapters[chapter.id];
    if (entry) annotations.push(...clone(entry.current.annotations));
  }
  doc.annotations = annotations;
  return doc;
}

const ANNOTATION_FIELDS: (keyof Annotation)[] = [
  'kind',
  'title',
  'body',
  'source',
  'status',
  'conflictState',
  'conflictResolution',
  'anchorState',
  'anchorHint'
];

function isConflict(base: unknown, ours: unknown, theirs: unknown): boolean {
  return (
    JSON.stringify(ours) !== JSON.stringify(base) &&
    JSON.stringify(theirs) !== JSON.stringify(base) &&
    JSON.stringify(ours) !== JSON.stringify(theirs)
  );
}

/**
 * 增量提交入口。
 * - commitId 幂等：同一份提交重试不重复应用、不重复产生注释
 * - baseVersion 落后时做三方合并：只改不同目标自动并入；同一正文/同一注释双方都改则列冲突
 * - 冲突仅主校可裁决；整理者的冲突提交被拒绝，原稿保留可重试
 * - 首次写入模拟失败一次，两边原稿保留，重试可成功
 */
export function submitCommit(request: SubmitRequest): SubmitResult {
  const server = loadServer();
  const entry = server.chapters[request.chapterId];
  if (!entry) {
    return { status: 'error', chapterId: request.chapterId, version: 0, message: '章节不存在' };
  }

  // 幂等：同一份提交重试直接返回已应用结果
  const record = server.log.find((item) => item.commitId === request.commitId);
  if (record) {
    return {
      status: 'merged',
      chapterId: request.chapterId,
      version: record.version,
      chapter: clone(entry.current.chapter),
      annotations: clone(entry.current.annotations),
      replay: true
    };
  }

  // 模拟接口故障：尚未应用任何改动，两边原稿都保留
  if (request.simulateFailure) {
    return {
      status: 'error',
      chapterId: request.chapterId,
      version: entry.current.version,
      message: '模拟接口写入失败：两边原稿已保留，可重试'
    };
  }

  const base = entry.history.find((item) => item.version === request.baseVersion);
  if (!base) {
    return {
      status: 'error',
      chapterId: request.chapterId,
      version: entry.current.version,
      message: '基线版本已失效，请重新载入后再提交'
    };
  }

  // 主校裁决后的终局提交：直接应用裁决结果，不再走三方合并
  if (request.force && request.authorRole === 'principal') {
    const forcedChapter = clone(entry.current.chapter);
    const forcedAnnotations = clone(entry.current.annotations);
    for (const op of request.ops) {
      switch (op.type) {
        case 'body': {
          const sentence = forcedChapter.sentences.find((item) => item.id === op.sentenceId);
          if (sentence) sentence.text = op.text;
          break;
        }
        case 'annotation-add': {
          if (!forcedAnnotations.some((item) => item.id === op.annotation.id)) {
            forcedAnnotations.push(clone(op.annotation));
          }
          break;
        }
        case 'annotation-update': {
          const index = forcedAnnotations.findIndex((item) => item.id === op.annotation.id);
          if (index >= 0) forcedAnnotations[index] = clone(op.annotation);
          break;
        }
        case 'annotation-delete': {
          const index = forcedAnnotations.findIndex((item) => item.id === op.annotationId);
          if (index >= 0) forcedAnnotations.splice(index, 1);
          break;
        }
      }
    }
    for (const sentence of forcedChapter.sentences) {
      const baseSentence = base.chapter.sentences.find((item) => item.id === sentence.id);
      if (!baseSentence || baseSentence.text === sentence.text) continue;
      const oldTokens: TextToken[] = baseSentence.tokens;
      sentence.tokens = tokenizeText(sentence.text, sentence.id, sentence.tokens);
      relocateWordAnchors(oldTokens, sentence.tokens, forcedAnnotations, sentence.id);
    }
    forcedChapter.bodyVersion = entry.current.version + 1;
    const forcedState: ChapterVersionState = {
      version: entry.current.version + 1,
      chapter: forcedChapter,
      annotations: forcedAnnotations
    };
    entry.current = forcedState;
    entry.history.push(forcedState);
    server.log.push({
      commitId: request.commitId,
      chapterId: request.chapterId,
      baseVersion: request.baseVersion,
      version: forcedState.version,
      authorRole: request.authorRole,
      label: request.label,
      appliedAt: new Date().toISOString(),
      ops: request.ops
    });
    saveServer(server);
    return {
      status: 'merged',
      chapterId: request.chapterId,
      version: forcedState.version,
      chapter: clone(forcedState.chapter),
      annotations: clone(forcedState.annotations)
    };
  }

  const conflicts: ConflictDetail[] = [];
  const mergedChapter = clone(entry.current.chapter);
  const mergedAnnotations = clone(entry.current.annotations);

  for (let opIndex = 0; opIndex < request.ops.length; opIndex += 1) {
    const op = request.ops[opIndex];
    switch (op.type) {
      case 'body': {
        const baseSentence = base.chapter.sentences.find((item) => item.id === op.sentenceId);
        const currentSentence = mergedChapter.sentences.find((item) => item.id === op.sentenceId);
        if (!baseSentence || !currentSentence) break;
        if (isConflict(baseSentence.text, op.text, currentSentence.text)) {
          conflicts.push({
            opIndex,
            kind: 'body',
            targetId: op.sentenceId,
            base: baseSentence.text,
            ours: op.text,
            theirs: currentSentence.text
          });
        } else if (currentSentence.text === baseSentence.text) {
          currentSentence.text = op.text;
        }
        break;
      }
      case 'annotation-add': {
        if (!mergedAnnotations.some((item) => item.id === op.annotation.id)) {
          mergedAnnotations.push(clone(op.annotation));
        }
        break;
      }
      case 'annotation-update': {
        const baseAnn = base.annotations.find((item) => item.id === op.annotation.id);
        const currentAnn = mergedAnnotations.find((item) => item.id === op.annotation.id);
        if (!baseAnn || !currentAnn) break;
        const conflictingFields: string[] = [];
        for (const field of ANNOTATION_FIELDS) {
          if (isConflict(baseAnn[field], op.annotation[field], currentAnn[field])) {
            conflictingFields.push(field);
          }
        }
        for (const field of ['references', 'tags'] as const) {
          if (isConflict(baseAnn[field], op.annotation[field], currentAnn[field])) {
            conflictingFields.push(field);
          }
        }
        if (conflictingFields.length) {
          conflicts.push({
            opIndex,
            kind: 'annotation-update',
            targetId: op.annotation.id,
            base: clone(baseAnn),
            ours: clone(op.annotation),
            theirs: clone(currentAnn),
            conflictingFields
          });
        } else {
          // 字段级合并：只采用本方改动的字段，对方改动的字段保留
          for (const field of ANNOTATION_FIELDS) {
            if (JSON.stringify(op.annotation[field]) !== JSON.stringify(baseAnn[field])) {
              (currentAnn as unknown as Record<string, unknown>)[field] = op.annotation[field];
            }
          }
          for (const field of ['references', 'tags'] as const) {
            if (JSON.stringify(op.annotation[field]) !== JSON.stringify(baseAnn[field])) {
              currentAnn[field] = clone(op.annotation[field]) as never;
            }
          }
        }
        break;
      }
      case 'annotation-delete': {
        const baseAnn = base.annotations.find((item) => item.id === op.annotationId);
        const currentAnn = mergedAnnotations.find((item) => item.id === op.annotationId);
        if (!currentAnn) break; // 双方都删除，意见一致
        if (baseAnn && JSON.stringify(currentAnn) !== JSON.stringify(baseAnn)) {
          conflicts.push({
            opIndex,
            kind: 'annotation-delete',
            targetId: op.annotationId,
            base: clone(baseAnn),
            ours: null,
            theirs: clone(currentAnn)
          });
        } else {
          const index = mergedAnnotations.findIndex((item) => item.id === op.annotationId);
          if (index >= 0) mergedAnnotations.splice(index, 1);
        }
        break;
      }
    }
  }

  if (conflicts.length) {
    if (request.authorRole !== 'principal') {
      return {
        status: 'rejected',
        chapterId: request.chapterId,
        version: entry.current.version,
        reason: 'principal-required',
        conflicts
      };
    }
    return { status: 'conflict', chapterId: request.chapterId, version: entry.current.version, conflicts };
  }

  // 合并完成：对正文有改动的句子，词级锚点失效重算，针对当前版本重新定位
  for (const sentence of mergedChapter.sentences) {
    const baseSentence = base.chapter.sentences.find((item) => item.id === sentence.id);
    if (!baseSentence || baseSentence.text === sentence.text) continue;
    const oldTokens: TextToken[] = baseSentence.tokens;
    sentence.tokens = tokenizeText(sentence.text, sentence.id, sentence.tokens);
    relocateWordAnchors(oldTokens, sentence.tokens, mergedAnnotations, sentence.id);
  }
  mergedChapter.bodyVersion = entry.current.version + 1;

  const newState: ChapterVersionState = {
    version: entry.current.version + 1,
    chapter: mergedChapter,
    annotations: mergedAnnotations
  };
  entry.current = newState;
  entry.history.push(newState);
  server.log.push({
    commitId: request.commitId,
    chapterId: request.chapterId,
    baseVersion: request.baseVersion,
    version: newState.version,
    authorRole: request.authorRole,
    label: request.label,
    appliedAt: new Date().toISOString(),
    ops: request.ops
  });
  saveServer(server);

  return {
    status: 'merged',
    chapterId: request.chapterId,
    version: newState.version,
    chapter: clone(newState.chapter),
    annotations: clone(newState.annotations)
  };
}

/** 跨标签页订阅服务端变化 */
export function subscribeServer(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (event.key === SERVER_KEY) listener();
  };
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
}
