'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { clone, type EditorAction } from './editor';
import {
  chapterAnnotations,
  diffChapterOps,
  loadPendingCommits,
  loadRole,
  savePendingCommits,
  saveRole,
  type CommitOp,
  type ConflictDetail,
  type PendingCommit,
  type Role
} from './collab';
import { getChapterState, reconstructDocument, submitCommit, subscribeServer } from './server';
import type { Annotation, TextDocument } from './types';

export type ConflictChoiceValue = 'ours' | 'theirs' | 'merged';
export type ConflictChoices = Record<number, { choice: ConflictChoiceValue; mergedText?: string }>;

interface BaseSnapshot {
  document: TextDocument;
  versions: Record<string, number>;
}

function snapshotBase(document: TextDocument): BaseSnapshot {
  const versions: Record<string, number> = {};
  for (const chapter of document.chapters) {
    versions[chapter.id] = chapter.bodyVersion;
  }
  return { document: clone(document), versions };
}

/** 计算某章相对基线的增量操作 */
function opsForChapter(base: BaseSnapshot, document: TextDocument, chapterId: string): CommitOp[] {
  const baseChapter = base.document.chapters.find((item) => item.id === chapterId);
  const localChapter = document.chapters.find((item) => item.id === chapterId);
  if (!baseChapter || !localChapter) return [];
  const baseAnnotations = chapterAnnotations(base.document, baseChapter);
  const localAnnotations = chapterAnnotations(document, localChapter);
  return diffChapterOps(baseChapter, baseAnnotations, localChapter, localAnnotations);
}

export interface UseChapterSyncResult {
  role: Role;
  setRole: (role: Role) => void;
  pending: PendingCommit[];
  newerAvailable: boolean;
  busy: boolean;
  chapterVersions: Record<string, number>;
  hasLocalEdits: boolean;
  simulateFailure: boolean;
  setSimulateFailure: (value: boolean) => void;
  initialize: (document: TextDocument) => void;
  submitChapter: (chapterId: string) => Promise<{ ok: boolean; message: string }>;
  retryCommit: (commitId: string) => Promise<{ ok: boolean; message: string }>;
  discardCommit: (commitId: string) => void;
  resolveConflict: (commitId: string, choices: ConflictChoices) => Promise<{ ok: boolean; message: string }>;
  pullServer: () => void;
}

export function useChapterSync(document: TextDocument, dispatch: Dispatch<EditorAction>): UseChapterSyncResult {
  const [role, setRoleState] = useState<Role>('editor');
  const [pending, setPending] = useState<PendingCommit[]>([]);
  const [newerAvailable, setNewerAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chapterVersions, setChapterVersions] = useState<Record<string, number>>({});
  const [simulateFailure, setSimulateFailure] = useState(false);
  const baseRef = useRef<BaseSnapshot>({ document: clone(document), versions: {} });
  const documentRef = useRef(document);
  documentRef.current = document;
  const initializedRef = useRef(false);

  // 持久化待办
  useEffect(() => {
    savePendingCommits(pending);
  }, [pending]);

  const setRole = useCallback((next: Role) => {
    setRoleState(next);
    saveRole(next);
  }, []);

  const refreshVersions = useCallback(() => {
    const versions: Record<string, number> = {};
    for (const chapter of document.chapters) {
      versions[chapter.id] = getChapterState(chapter.id)?.version ?? chapter.bodyVersion;
    }
    setChapterVersions(versions);
  }, [document.chapters]);

  const applyServerDocument = useCallback(
    (serverDocument: TextDocument, label: string) => {
      baseRef.current = snapshotBase(serverDocument);
      dispatch({ type: 'syncDocument', document: serverDocument, label });
      refreshVersions();
    },
    [dispatch, refreshVersions]
  );

  const initialize = useCallback(
    (localDocument: TextDocument) => {
      if (initializedRef.current) return;
      initializedRef.current = true;
      setRoleState(loadRole());
      setPending(loadPendingCommits());

      const serverDocument = reconstructDocument();
      const serverBase = snapshotBase(serverDocument);
      baseRef.current = serverBase;

      // 本地草稿与服务端一致 → 直接同步；否则保留本地修改，下次保存自动合并
      const localHasEdits = localDocument.chapters.some((chapter) => {
        const baseChapter = serverDocument.chapters.find((item) => item.id === chapter.id);
        if (!baseChapter) return false;
        return diffChapterOps(
          baseChapter,
          chapterAnnotations(serverDocument, baseChapter),
          chapter,
          chapterAnnotations(localDocument, chapter)
        ).length > 0;
      });

      if (localHasEdits) {
        setNewerAvailable(false);
      } else {
        dispatch({ type: 'syncDocument', document: serverDocument, label: '已载入协同底本' });
      }
      refreshVersions();
    },
    [dispatch, refreshVersions]
  );

  // 跨标签页同步
  useEffect(() => {
    if (!initializedRef.current) return;
    const unsubscribe = subscribeServer(() => {
      const serverDocument = reconstructDocument();
      const localHasEdits = document.chapters.some((chapter) => {
        const baseChapter = baseRef.current.document.chapters.find((item) => item.id === chapter.id);
        if (!baseChapter) return false;
        return (
          diffChapterOps(
            baseChapter,
            chapterAnnotations(baseRef.current.document, baseChapter),
            chapter,
            chapterAnnotations(document, chapter)
          ).length > 0
        );
      });
      if (localHasEdits) {
        setNewerAvailable(true);
      } else {
        baseRef.current = snapshotBase(serverDocument);
        dispatch({ type: 'syncDocument', document: serverDocument, label: '已同步协作者版本' });
        refreshVersions();
      }
    });
    return unsubscribe;
  }, [dispatch, document, refreshVersions]);

  const hasLocalEdits = useMemo(
    () =>
      document.chapters.some((chapter) => {
        const baseChapter = baseRef.current.document.chapters.find((item) => item.id === chapter.id);
        if (!baseChapter) return false;
        return (
          diffChapterOps(
            baseChapter,
            chapterAnnotations(baseRef.current.document, baseChapter),
            chapter,
            chapterAnnotations(document, chapter)
          ).length > 0
        );
      }),
    [document]
  );

  const pullServer = useCallback(() => {
    const serverDocument = reconstructDocument();
    baseRef.current = snapshotBase(serverDocument);
    dispatch({ type: 'syncDocument', document: serverDocument, label: '已重新载入协同版本' });
    setNewerAvailable(false);
    refreshVersions();
  }, [dispatch, refreshVersions]);

  const runSubmit = useCallback(
    async (commit: PendingCommit): Promise<{ ok: boolean; message: string }> => {
      setBusy(true);
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const result = submitCommit({
        commitId: commit.commitId,
        chapterId: commit.chapterId,
        baseVersion: commit.baseVersion,
        ops: commit.ops,
        authorRole: role,
        label: commit.label,
        force: commit.force,
        simulateFailure
      });
      if (simulateFailure) setSimulateFailure(false);
      setBusy(false);

      if (result.status === 'merged') {
        const serverDocument = reconstructDocument();
        baseRef.current = snapshotBase(serverDocument);
        dispatch({ type: 'syncDocument', document: serverDocument, label: `已合并保存：${commit.label}` });
        setPending((current) => current.filter((item) => item.commitId !== commit.commitId));
        setNewerAvailable(false);
        refreshVersions();
        return {
          ok: true,
          message: result.replay
            ? '同一份提交已处理过，未重复产生注释'
            : `已自动合并到正文 v${result.version}（只改不同目标已并入）`
        };
      }

      if (result.status === 'conflict') {
        setPending((current) =>
          current.map((item) =>
            item.commitId === commit.commitId ? { ...item, status: 'conflict', conflicts: result.conflicts } : item
          )
        );
        return { ok: false, message: '同一处正文/注释双方都改了，已列冲突，等待主校裁决' };
      }

      if (result.status === 'rejected') {
        setPending((current) =>
          current.map((item) =>
            item.commitId === commit.commitId
              ? { ...item, status: 'rejected', conflicts: result.conflicts, message: '越权：仅主校可解决冲突' }
              : item
          )
        );
        return { ok: false, message: '越权保存被拒绝：冲突仅主校可裁决，已保留原稿可重试' };
      }

      setPending((current) =>
        current.map((item) =>
          item.commitId === commit.commitId ? { ...item, status: 'error', message: result.message } : item
        )
      );
      return { ok: false, message: result.message };
    },
    [dispatch, refreshVersions, role, simulateFailure]
  );

  const submitChapter = useCallback(
    async (chapterId: string): Promise<{ ok: boolean; message: string }> => {
      const base = baseRef.current;
      const ops = opsForChapter(base, document, chapterId);
      if (!ops.length) return { ok: true, message: '没有需要保存的修改' };

      const chapter = document.chapters.find((item) => item.id === chapterId);
      const commit: PendingCommit = {
        commitId: `commit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        chapterId,
        label: `保存${chapter?.title ?? '章节'}`,
        ops,
        baseVersion: base.versions[chapterId] ?? chapter?.bodyVersion ?? 1,
        createdAt: new Date().toISOString(),
        status: 'pending'
      };
      setPending((current) => [...current, commit]);
      return runSubmit(commit);
    },
    [document, runSubmit]
  );

  const retryCommit = useCallback(
    async (commitId: string): Promise<{ ok: boolean; message: string }> => {
      const commit = pending.find((item) => item.commitId === commitId);
      if (!commit) return { ok: false, message: '找不到待重试的提交' };
      // 按当前草稿重新计算增量，覆盖提交后新增的修改
      const base = baseRef.current;
      const ops = opsForChapter(base, document, commit.chapterId);
      const refreshed: PendingCommit = {
        ...commit,
        ops,
        baseVersion: base.versions[commit.chapterId] ?? commit.baseVersion,
        status: 'pending',
        conflicts: undefined,
        message: undefined
      };
      setPending((current) => current.map((item) => (item.commitId === commitId ? refreshed : item)));
      return runSubmit(refreshed);
    },
    [document, pending, runSubmit]
  );

  const discardCommit = useCallback((commitId: string) => {
    setPending((current) => current.filter((item) => item.commitId !== commitId));
  }, []);

  const resolveConflict = useCallback(
    async (commitId: string, choices: ConflictChoices): Promise<{ ok: boolean; message: string }> => {
      const commit = pending.find((item) => item.commitId === commitId);
      if (!commit || !commit.conflicts) return { ok: false, message: '找不到冲突详情' };

      // 按主校选择把“对方版本”应用到本地草稿，再重新提交
      dispatch({
        type: 'commit',
        label: '按主校选择解决冲突',
        mutate: (doc) => {
          for (const conflict of commit.conflicts!) {
            const choice = choices[conflict.opIndex]?.choice ?? 'ours';
            if (choice === 'ours') continue;
            if (conflict.kind === 'body') {
              const sentence = doc.chapters
                .flatMap((chapter) => chapter.sentences)
                .find((item) => item.id === conflict.targetId);
              if (!sentence) continue;
              if (choice === 'theirs') {
                sentence.text = conflict.theirs as string;
              } else {
                sentence.text = choices[conflict.opIndex]?.mergedText ?? (conflict.ours as string);
              }
            } else if (conflict.kind === 'annotation-update') {
              const target = doc.annotations.find((item) => item.id === conflict.targetId);
              if (!target) continue;
              if (choice === 'theirs') {
                Object.assign(target, clone(conflict.theirs as Annotation));
              } else {
                const merged = mergeAnnotationFields(
                  conflict.base as Annotation,
                  conflict.ours as Annotation,
                  conflict.theirs as Annotation,
                  conflict.conflictingFields ?? []
                );
                Object.assign(target, merged);
              }
            } else if (conflict.kind === 'annotation-delete') {
              if (choice === 'theirs') {
                const exists = doc.annotations.some((item) => item.id === conflict.targetId);
                if (!exists) doc.annotations.push(clone(conflict.theirs as Annotation));
              }
            }
          }
        }
      });

      // 等 dispatch 生效后重新计算增量，主校裁决为终局，直接应用结果
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const base = baseRef.current;
      const ops = opsForChapter(base, documentRef.current, commit.chapterId);
      const resolved: PendingCommit = {
        ...commit,
        ops,
        baseVersion: base.versions[commit.chapterId] ?? commit.baseVersion,
        status: 'pending',
        conflicts: undefined,
        message: undefined,
        force: true
      };
      setPending((current) => current.map((item) => (item.commitId === commitId ? resolved : item)));
      return runSubmit(resolved);
    },
    [dispatch, pending, runSubmit]
  );

  return {
    role,
    setRole,
    pending,
    newerAvailable,
    busy,
    chapterVersions,
    hasLocalEdits,
    simulateFailure,
    setSimulateFailure,
    initialize,
    submitChapter,
    retryCommit,
    discardCommit,
    resolveConflict,
    pullServer
  };
}

/** 注释字段级合并：双方都改的字段默认取本方，其余取各自改动 */
function mergeAnnotationFields(base: Annotation, ours: Annotation, theirs: Annotation, conflictingFields: string[]): Partial<Annotation> {
  const merged: Record<string, unknown> = {};
  const fields = new Set<keyof Annotation>([
    'kind',
    'title',
    'body',
    'source',
    'status',
    'conflictState',
    'conflictResolution',
    'anchorState',
    'anchorHint',
    'references',
    'tags'
  ]);
  for (const field of fields) {
    const baseValue = base[field];
    const oursValue = ours[field];
    const theirsValue = theirs[field];
    const oursChanged = JSON.stringify(oursValue) !== JSON.stringify(baseValue);
    const theirsChanged = JSON.stringify(theirsValue) !== JSON.stringify(baseValue);
    if (oursChanged && theirsChanged) {
      merged[field] = conflictingFields.includes(field) ? oursValue : oursValue;
    } else if (oursChanged) {
      merged[field] = oursValue;
    } else if (theirsChanged) {
      merged[field] = theirsValue;
    } else {
      merged[field] = baseValue;
    }
  }
  return merged as Partial<Annotation>;
}
