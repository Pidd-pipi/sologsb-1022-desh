export type ViewMode = 'reading' | 'editing' | 'critical';
export type AnchorType = 'chapter' | 'sentence' | 'word';
export type AnnotationKind = 'footnote' | 'variant' | 'background' | 'crossref';
export type AnnotationStatus = 'open' | 'resolved';
export type UserRole = 'chief' | 'editor';

export interface TextToken {
  id: string;
  text: string;
}

export interface Sentence {
  id: string;
  order: number;
  text: string;
  tokens: TextToken[];
}

export interface Chapter {
  id: string;
  order: number;
  title: string;
  summary: string;
  sentences: Sentence[];
}

export interface Annotation {
  id: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  title: string;
  body: string;
  source: string;
  references: string[];
  status: AnnotationStatus;
  tags: string[];
  conflictState: 'open' | 'resolved';
  conflictResolution?: string;
  /** 正文修订后未能重新定位到原词，已降级到所属句，等待整理者确认 */
  pendingRelocation?: boolean;
  updatedAt: string;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface TextDocument {
  id: string;
  title: string;
  author: string;
  edition: string;
  chapters: Chapter[];
  annotations: Annotation[];
  snapshots: VersionSnapshot[];
  updatedAt: string;
}

export interface WorkspaceState {
  document: TextDocument;
  mode: ViewMode;
  selectedChapterId: string;
  selectedSentenceId: string;
  selectedAnnotationId: string | null;
  query: string;
  dirty: boolean;
}

export interface EditorState {
  workspace: WorkspaceState;
  past: WorkspaceState[];
  future: WorkspaceState[];
  lastAction: string;
}

export interface SearchResult {
  chapterId: string;
  sentenceId?: string;
  annotationId?: string;
  title: string;
  excerpt: string;
  kind: 'text' | 'annotation';
}

export interface ConflictGroup {
  key: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  anchorLabel: string;
  annotations: Annotation[];
}

/** 两个窗口基于同一正文版本改动了同一目标时产生的合并冲突 */
export interface MergeConflict {
  id: string;
  target: 'annotation' | 'sentence';
  targetId: string;
  chapterId: string;
  label: string;
  baseBody: string;
  serverBody: string;
  localBody: string;
  serverSource: string;
  localSource: string;
  /** 本地版本的完整注释，裁定“采用本地”时写回 */
  localAnnotation?: Annotation;
  localDeleted?: boolean;
  serverDeleted?: boolean;
  status: 'pending' | 'resolved';
  resolution?: 'server' | 'local' | 'merged';
  resolvedBy?: UserRole;
  createdAt: string;
}

export interface ConflictResolution {
  conflictId: string;
  choice: 'server' | 'local' | 'merged';
}

/** 章节增量提交：携带所基于的正文版本（baseRevision）与本地草稿 */
export interface ChapterCommit {
  submissionId: string;
  chapterId: string;
  baseRevision: number;
  role: UserRole;
  draft: { chapters: Chapter[]; annotations: Annotation[] };
  resolutions?: ConflictResolution[];
}

export type CommitStatus = 'applied' | 'merged' | 'conflict' | 'rejected' | 'duplicate';

export interface CommitResult {
  status: CommitStatus;
  revision: number;
  message: string;
  chapters: Chapter[];
  annotations: Annotation[];
  conflicts: MergeConflict[];
}

/** 写入失败后保留的未完成提交，用于重试与重新打开后恢复 */
export interface PendingCommit {
  payload: ChapterCommit;
  draftSignature: string;
  attempts: number;
  lastError: string;
  createdAt: string;
}
