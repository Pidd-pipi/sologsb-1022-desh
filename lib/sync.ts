import { initialDocument, tokenizeText } from './data';
import { clone } from './editor';
import type {
  Annotation,
  Chapter,
  ChapterCommit,
  CommitResult,
  ConflictResolution,
  MergeConflict,
  PendingCommit,
  Sentence,
  TextDocument,
  UserRole
} from './types';

export const SERVER_STORAGE_KEY = 'sologsb-1022/public-text-annotator/server/v1';
export const PENDING_STORAGE_KEY = 'sologsb-1022/public-text-annotator/pending/v1';
export const DRAFT_KEY_PREFIX = 'sologsb-1022/public-text-annotator/draft/';
export const TAB_ID_KEY = 'sologsb-1022/public-text-annotator/tab-id';

const HISTORY_LIMIT = 50;

/** 模拟服务端：保存合并后的正文、注释、待裁定冲突与已处理提交（幂等键） */
export interface ServerState {
  revision: number;
  chapters: Chapter[];
  annotations: Annotation[];
  conflicts: MergeConflict[];
  submissions: Record<string, { revision: number; status: CommitResult['status']; message: string }>;
  history: { revision: number; chapters: Chapter[]; annotations: Annotation[] }[];
}

export class SyncWriteError extends Error {}
export class SyncLostResponseError extends Error {}

export type FailureMode = 'none' | 'write' | 'lost-response';

export function createServerState(document: TextDocument): ServerState {
  return {
    revision: 1,
    chapters: clone(document.chapters),
    annotations: clone(document.annotations),
    conflicts: [],
    submissions: {},
    history: [{ revision: 1, chapters: clone(document.chapters), annotations: clone(document.annotations) }]
  };
}

function canUseStorage() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

let memoryServer: ServerState | null = null;

export function persistServerState(state: ServerState) {
  memoryServer = state;
  if (canUseStorage()) {
    try {
      localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 存储不可用时仅保留内存态 */
    }
  }
}

export function loadServerState(): ServerState {
  if (canUseStorage()) {
    try {
      const raw = localStorage.getItem(SERVER_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ServerState;
        if (parsed && typeof parsed.revision === 'number' && Array.isArray(parsed.chapters)) return parsed;
      }
    } catch {
      /* 损坏则重建 */
    }
  }
  if (memoryServer) return memoryServer;
  const fresh = createServerState(initialDocument);
  persistServerState(fresh);
  return fresh;
}

export function resetServerState(): ServerState {
  const fresh = createServerState(initialDocument);
  persistServerState(fresh);
  return fresh;
}

export function getServerInfo() {
  const server = loadServerState();
  return {
    revision: server.revision,
    chapters: clone(server.chapters),
    annotations: clone(server.annotations),
    pendingConflicts: server.conflicts.filter((conflict) => conflict.status === 'pending')
  };
}

export function loadPendingCommits(): Record<string, PendingCommit> {
  if (!canUseStorage()) return {};
  try {
    return (JSON.parse(localStorage.getItem(PENDING_STORAGE_KEY) ?? '{}') as Record<string, PendingCommit>) ?? {};
  } catch {
    return {};
  }
}

export function savePendingCommit(tabId: string, pending: PendingCommit | null) {
  if (!canUseStorage()) return;
  const all = loadPendingCommits();
  if (pending) all[tabId] = pending;
  else delete all[tabId];
  try {
    localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 忽略配额错误 */
  }
}

export function draftSignature(draft: { chapters: Chapter[]; annotations: Annotation[] }): string {
  return JSON.stringify([draft.chapters, draft.annotations]);
}

function annotationSignature(annotation: Annotation): string {
  return JSON.stringify([
    annotation.anchorId,
    annotation.anchorType,
    annotation.kind,
    annotation.title,
    annotation.body,
    annotation.source,
    annotation.references,
    annotation.status,
    annotation.tags,
    annotation.conflictState,
    Boolean(annotation.pendingRelocation)
  ]);
}

interface MergeComputation {
  chapters: Chapter[];
  annotations: Annotation[];
  conflicts: MergeConflict[];
  notes: string[];
}

/**
 * 三方合并：以 base（提交所基于的正文版本）为共同祖先，
 * 服务端与本地草稿各自改动不同目标时自动并入；同一目标两边都改则记录冲突。
 */
export function computeMerge(
  server: ServerState,
  base: { chapters: Chapter[]; annotations: Annotation[] },
  commit: ChapterCommit,
  now: string
): MergeComputation {
  const notes: string[] = [];
  const conflicts: MergeConflict[] = [];
  const draft = commit.draft;
  let conflictSeq = 0;
  const nextConflictId = () => {
    conflictSeq += 1;
    return `mc-${commit.submissionId}-${conflictSeq}`;
  };

  // ---- 正文：按章节、句子逐目标三方合并 ----
  const baseChapters = new Map(base.chapters.map((chapter) => [chapter.id, chapter]));
  const serverChapters = new Map(server.chapters.map((chapter) => [chapter.id, chapter]));
  const draftChapters = new Map(draft.chapters.map((chapter) => [chapter.id, chapter]));
  const chapterOrder: string[] = [];
  for (const chapter of server.chapters) chapterOrder.push(chapter.id);
  for (const chapter of draft.chapters) if (!chapterOrder.includes(chapter.id)) chapterOrder.push(chapter.id);

  const mergedChapters: Chapter[] = [];
  let textApplied = 0;
  let textConflicts = 0;

  for (const chapterId of chapterOrder) {
    const baseChapter = baseChapters.get(chapterId);
    const serverChapter = serverChapters.get(chapterId);
    const draftChapter = draftChapters.get(chapterId);
    if (serverChapter && !draftChapter) {
      mergedChapters.push(clone(serverChapter));
      continue;
    }
    if (!serverChapter && draftChapter) {
      mergedChapters.push(clone(draftChapter));
      continue;
    }
    if (!serverChapter || !draftChapter) continue;

    const mergedChapter = clone(serverChapter);
    if (baseChapter) {
      if (draftChapter.title !== baseChapter.title) mergedChapter.title = draftChapter.title;
      if (draftChapter.summary !== baseChapter.summary) mergedChapter.summary = draftChapter.summary;
    }

    const baseSentences = new Map((baseChapter?.sentences ?? []).map((sentence) => [sentence.id, sentence]));
    const serverSentences = new Map(serverChapter.sentences.map((sentence) => [sentence.id, sentence]));
    const draftSentences = new Map(draftChapter.sentences.map((sentence) => [sentence.id, sentence]));
    const sentenceOrder: string[] = [];
    for (const sentence of serverChapter.sentences) sentenceOrder.push(sentence.id);
    for (const sentence of draftChapter.sentences) if (!sentenceOrder.includes(sentence.id)) sentenceOrder.push(sentence.id);

    const sentences: Sentence[] = [];
    for (const sentenceId of sentenceOrder) {
      const b = baseSentences.get(sentenceId);
      const s = serverSentences.get(sentenceId);
      const d = draftSentences.get(sentenceId);
      if (s && !d) {
        sentences.push(clone(s));
        continue;
      }
      if (!s && d) {
        sentences.push(clone(d));
        continue;
      }
      if (!s || !d) continue;
      if (!b) {
        sentences.push(clone(s));
        continue;
      }
      const localChanged = d.text !== b.text;
      const serverChanged = s.text !== b.text;
      if (localChanged && serverChanged && d.text !== s.text) {
        textConflicts += 1;
        conflicts.push({
          id: nextConflictId(),
          target: 'sentence',
          targetId: sentenceId,
          chapterId,
          label: `《${serverChapter.title}》第 ${s.order} 句正文`,
          baseBody: b.text,
          serverBody: s.text,
          localBody: d.text,
          serverSource: '服务端版本',
          localSource: '本地草稿',
          status: 'pending',
          createdAt: now
        });
        sentences.push(clone(s));
      } else if (localChanged) {
        textApplied += 1;
        // 复用服务端 token id，尽量保住已有的词级引用
        sentences.push({ ...clone(s), text: d.text, tokens: tokenizeText(d.text, s.id, s.tokens) });
      } else {
        sentences.push(clone(s));
      }
    }
    mergedChapter.sentences = sentences;
    mergedChapters.push(mergedChapter);
  }

  if (textApplied) notes.push(`并入正文改动 ${textApplied} 处`);
  if (textConflicts) notes.push(`${textConflicts} 处正文两边都改，列为冲突待主校裁定`);

  // ---- 注释：按 id 三方合并 ----
  const baseAnnotations = new Map(base.annotations.map((annotation) => [annotation.id, annotation]));
  const serverAnnotations = new Map(server.annotations.map((annotation) => [annotation.id, annotation]));
  const draftAnnotations = new Map(draft.annotations.map((annotation) => [annotation.id, annotation]));
  const annotationOrder: string[] = [];
  for (const annotation of server.annotations) annotationOrder.push(annotation.id);
  for (const annotation of draft.annotations) if (!annotationOrder.includes(annotation.id)) annotationOrder.push(annotation.id);

  const mergedAnnotations: Annotation[] = [];
  let added = 0;
  let updated = 0;
  let removed = 0;
  let annotationConflicts = 0;

  for (const id of annotationOrder) {
    const b = baseAnnotations.get(id);
    const s = serverAnnotations.get(id);
    const d = draftAnnotations.get(id);

    if (b) {
      const localChanged = d ? annotationSignature(d) !== annotationSignature(b) : false;
      const serverChanged = s ? annotationSignature(s) !== annotationSignature(b) : false;
      if (d && s) {
        if (localChanged && serverChanged && annotationSignature(d) !== annotationSignature(s)) {
          annotationConflicts += 1;
          conflicts.push({
            id: nextConflictId(),
            target: 'annotation',
            targetId: id,
            chapterId: commit.chapterId,
            label: `注释「${s.title}」`,
            baseBody: b.body,
            serverBody: s.body,
            localBody: d.body,
            serverSource: s.source,
            localSource: d.source,
            localAnnotation: clone(d),
            status: 'pending',
            createdAt: now
          });
          mergedAnnotations.push(clone(s));
        } else if (localChanged) {
          mergedAnnotations.push(clone(d));
          updated += 1;
        } else {
          mergedAnnotations.push(clone(s));
        }
      } else if (d && !s) {
        if (localChanged) {
          annotationConflicts += 1;
          conflicts.push({
            id: nextConflictId(),
            target: 'annotation',
            targetId: id,
            chapterId: commit.chapterId,
            label: `注释「${d.title}」`,
            baseBody: b.body,
            serverBody: '（服务端已删除）',
            localBody: d.body,
            serverSource: '服务端版本',
            localSource: d.source,
            localAnnotation: clone(d),
            serverDeleted: true,
            status: 'pending',
            createdAt: now
          });
        } else {
          removed += 1;
        }
      } else if (!d && s) {
        if (serverChanged) {
          annotationConflicts += 1;
          conflicts.push({
            id: nextConflictId(),
            target: 'annotation',
            targetId: id,
            chapterId: commit.chapterId,
            label: `注释「${s.title}」`,
            baseBody: b.body,
            serverBody: s.body,
            localBody: '（本地已删除）',
            serverSource: s.source,
            localSource: '本地草稿',
            localDeleted: true,
            status: 'pending',
            createdAt: now
          });
          mergedAnnotations.push(clone(s));
        } else {
          removed += 1;
        }
      }
    } else if (d && !s) {
      mergedAnnotations.push(clone(d));
      added += 1;
    } else if (d && s) {
      if (annotationSignature(d) === annotationSignature(s)) {
        mergedAnnotations.push(clone(s));
      } else {
        // 不同提交撞上了同一个注释 id：保留服务端，本地版本改号收录，避免覆盖
        const copy = clone(d);
        copy.id = `${d.id}-r${server.revision + 1}`;
        mergedAnnotations.push(clone(s), copy);
        added += 1;
        notes.push(`注释「${d.title}」编号与服务端冲突，已改记为 ${copy.id}`);
      }
    } else if (!d && s) {
      mergedAnnotations.push(clone(s));
    }
  }

  if (added) notes.push(`新增注释 ${added} 条`);
  if (updated) notes.push(`更新注释 ${updated} 条`);
  if (removed) notes.push(`删除注释 ${removed} 条`);
  if (annotationConflicts) notes.push(`${annotationConflicts} 条注释两边都改，列为冲突待主校裁定`);

  return { chapters: mergedChapters, annotations: mergedAnnotations, conflicts, notes };
}

/**
 * 正文修订后词级注释失效重算：按当前版本重新定位原词；
 * 找不到则降级到所属句并标记待确认。
 */
export function reanchorWordAnnotations(
  chapters: Chapter[],
  annotations: Annotation[],
  sources: { chapters: Chapter[] }[]
): { relocated: number; demoted: number } {
  const tokenIds = new Set<string>();
  const sentenceById = new Map<string, Sentence>();
  for (const chapter of chapters) {
    for (const sentence of chapter.sentences) {
      sentenceById.set(sentence.id, sentence);
      for (const token of sentence.tokens) tokenIds.add(token.id);
    }
  }

  const historical = new Map<string, { text: string; sentenceId: string }>();
  for (const source of sources) {
    for (const chapter of source.chapters) {
      for (const sentence of chapter.sentences) {
        for (const token of sentence.tokens) {
          if (!historical.has(token.id)) historical.set(token.id, { text: token.text, sentenceId: sentence.id });
        }
      }
    }
  }

  let relocated = 0;
  let demoted = 0;
  for (const annotation of annotations) {
    if (annotation.anchorType !== 'word') continue;
    if (tokenIds.has(annotation.anchorId)) {
      annotation.pendingRelocation = false;
      continue;
    }
    const info = historical.get(annotation.anchorId);
    const sentence = info ? sentenceById.get(info.sentenceId) : undefined;
    if (info && sentence) {
      const candidate =
        sentence.tokens.find((token) => token.text === info.text) ??
        sentence.tokens.find((token) => token.text.trim() === info.text.trim());
      if (candidate) {
        annotation.anchorId = candidate.id;
        annotation.pendingRelocation = false;
        relocated += 1;
        continue;
      }
      annotation.anchorId = sentence.id;
      annotation.anchorType = 'sentence';
      annotation.pendingRelocation = true;
      demoted += 1;
    } else {
      annotation.pendingRelocation = true;
      demoted += 1;
    }
  }
  return { relocated, demoted };
}

/** 仅主校可调用：把裁定结果写入合并后的文档，并标记冲突已解决 */
export function applyResolutions(
  chapters: Chapter[],
  annotations: Annotation[],
  conflicts: MergeConflict[],
  resolutions: ConflictResolution[],
  role: UserRole,
  now: string
): string[] {
  const notes: string[] = [];
  for (const resolution of resolutions) {
    const conflict = conflicts.find((item) => item.id === resolution.conflictId && item.status === 'pending');
    if (!conflict) {
      notes.push('有一条裁定未找到对应冲突或已被处理');
      continue;
    }
    if (conflict.target === 'annotation') {
      const index = annotations.findIndex((annotation) => annotation.id === conflict.targetId);
      if (resolution.choice === 'local') {
        if (conflict.localDeleted) {
          if (index >= 0) annotations.splice(index, 1);
        } else if (conflict.localAnnotation) {
          const next = { ...clone(conflict.localAnnotation), updatedAt: now };
          if (index >= 0) annotations[index] = next;
          else annotations.push(next);
        }
      } else if (resolution.choice === 'merged' && index >= 0) {
        annotations[index] = {
          ...annotations[index],
          body: `【${conflict.serverSource}】${conflict.serverBody}\n\n【${conflict.localSource}】${conflict.localBody}`,
          updatedAt: now
        };
      }
    } else if (resolution.choice === 'local') {
      for (const chapter of chapters) {
        const sentence = chapter.sentences.find((item) => item.id === conflict.targetId);
        if (sentence) {
          sentence.text = conflict.localBody;
          sentence.tokens = tokenizeText(conflict.localBody, sentence.id, sentence.tokens);
          break;
        }
      }
    }
    conflict.status = 'resolved';
    conflict.resolution = resolution.choice;
    conflict.resolvedBy = role;
    const choiceLabel = resolution.choice === 'local' ? '采用本地' : resolution.choice === 'merged' ? '合并两者' : '保留服务端';
    notes.push(`冲突「${conflict.label}」已裁定：${choiceLabel}`);
  }
  return notes;
}

/** 交叉引用按合并结果清理：目标注释不存在时移除引用，避免悬空 */
export function pruneReferences(annotations: Annotation[]) {
  const ids = new Set(annotations.map((annotation) => annotation.id));
  for (const annotation of annotations) {
    annotation.references = annotation.references.filter((id) => ids.has(id));
  }
}

export interface ApplyOptions {
  failureMode?: FailureMode;
  now?: string;
}

/** 纯函数：在内存中的服务端状态上应用一次增量提交，返回结果与新状态（不落盘） */
export function applyChapterCommitToState(
  server: ServerState,
  commit: ChapterCommit,
  options: ApplyOptions = {}
): { result: CommitResult; next: ServerState } {
  const now = options.now ?? new Date().toISOString();

  // 幂等：同一份提交重试直接返回首次结果，不重复产生注释
  const seen = server.submissions[commit.submissionId];
  if (seen) {
    return {
      result: {
        status: 'duplicate',
        revision: server.revision,
        message: `重复提交已去重，未重复写入（首次结果：${seen.message}）`,
        chapters: clone(server.chapters),
        annotations: clone(server.annotations),
        conflicts: server.conflicts.filter((conflict) => conflict.status === 'pending')
      },
      next: server
    };
  }

  // 越权：只有主校角色能提交冲突裁定
  if (commit.resolutions?.length && commit.role !== 'chief') {
    return {
      result: {
        status: 'rejected',
        revision: server.revision,
        message: '已拒绝：仅主校角色可裁定合并结果，本次保存未写入。',
        chapters: clone(server.chapters),
        annotations: clone(server.annotations),
        conflicts: server.conflicts.filter((conflict) => conflict.status === 'pending')
      },
      next: server
    };
  }

  const base =
    commit.baseRevision === server.revision
      ? { chapters: server.chapters, annotations: server.annotations }
      : server.history.find((entry) => entry.revision === commit.baseRevision);
  if (!base) {
    return {
      result: {
        status: 'rejected',
        revision: server.revision,
        message: `基线版本 v${commit.baseRevision} 已超出保留范围，请载入服务端最新版本后重试。`,
        chapters: clone(server.chapters),
        annotations: clone(server.annotations),
        conflicts: server.conflicts.filter((conflict) => conflict.status === 'pending')
      },
      next: server
    };
  }

  const merged = computeMerge(server, base, commit, now);
  const conflicts = [...server.conflicts, ...merged.conflicts];
  const resolutionNotes = commit.resolutions?.length
    ? applyResolutions(merged.chapters, merged.annotations, conflicts, commit.resolutions, commit.role, now)
    : [];
  const { relocated, demoted } = reanchorWordAnnotations(merged.chapters, merged.annotations, [base, server, commit.draft]);
  pruneReferences(merged.annotations);

  const notes = [...merged.notes, ...resolutionNotes];
  if (relocated) notes.push(`${relocated} 条词级注释已按当前版本重新定位`);
  if (demoted) notes.push(`${demoted} 条词级注释未找到原词，已降到所属句并标记待确认`);
  if (!notes.length) notes.push('没有需要并入的改动');

  const status: CommitResult['status'] = merged.conflicts.length
    ? 'conflict'
    : commit.baseRevision === server.revision
      ? 'applied'
      : 'merged';

  const nextRevision = server.revision + 1;
  const message = notes.join('；');
  const next: ServerState = {
    revision: nextRevision,
    chapters: merged.chapters,
    annotations: merged.annotations,
    conflicts,
    submissions: { ...server.submissions, [commit.submissionId]: { revision: nextRevision, status, message } },
    history: [
      ...server.history,
      { revision: nextRevision, chapters: clone(merged.chapters), annotations: clone(merged.annotations) }
    ].slice(-HISTORY_LIMIT)
  };

  return {
    result: {
      status,
      revision: nextRevision,
      message,
      chapters: clone(merged.chapters),
      annotations: clone(merged.annotations),
      conflicts: conflicts.filter((conflict) => conflict.status === 'pending')
    },
    next
  };
}

/** 带持久化与故障注入的提交入口（模拟接口） */
export function applyChapterCommit(commit: ChapterCommit, options: ApplyOptions = {}): CommitResult {
  const server = loadServerState();
  const { result, next } = applyChapterCommitToState(server, commit, options);
  if (next !== server) {
    const failureMode = options.failureMode ?? 'none';
    if (failureMode === 'write') {
      throw new SyncWriteError('模拟写入失败：服务端存储不可用，未写入任何内容');
    }
    persistServerState(next);
    if (failureMode === 'lost-response') {
      throw new SyncLostResponseError('模拟故障：服务端已写入，但响应在传输中丢失');
    }
  }
  return result;
}
