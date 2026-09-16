export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'cancelled';
export type TaskPriority = 'high' | 'medium' | 'low';
export type MemoryStatus = 'candidate' | 'confirmed' | 'superseded' | 'invalidated' | 'rejected';

export interface ProjectRecord {
  id: string;
  name: string;
  summary: string;
  status: ProjectStatus;
  priority: TaskPriority;
  vaultPath: string;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
}
