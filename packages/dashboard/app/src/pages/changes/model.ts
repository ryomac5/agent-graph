import { getRegisteredProjects, OTHER_PROJECT } from '../../lib/projects.ts';
import type { Row, ScreenState } from '../../lib/store.ts';
import type { Attribution } from '../../components/diff/model.ts';

export function readText(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function readValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}
export function readObject(value: unknown): Row {
  const parsed = readValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
}
export function readAttribution(value: unknown): Attribution {
  return value === 'confirmed' || value === 'inferred' || value === 'joint' ? value : 'unknown';
}
export function selectArtifacts(state: ScreenState, project?: string): Row[] {
  return (state.projection.artifacts ?? []).filter(artifact => {
    if (!project || artifact.repository_id === project) return true;
    const run = state.projection.runs?.find(row => row.id === artifact.run_id);
    const conversation = state.projection.conversations?.find(row => row.id === run?.conversation_id);
    if (project === OTHER_PROJECT) {
      const task = state.projection.tasks?.find(row => row.id === conversation?.task_id);
      const id = conversation?.project ?? task?.project ?? artifact.repository_id;
      return !getRegisteredProjects(state).some(row => row.id === id);
    }
    return state.projection.tasks?.some(row => row.id === conversation?.task_id && row.project === project);
  }).sort((a, b) => Number(a.version) - Number(b.version) || readText(a.id).localeCompare(readText(b.id)));
}
// 別タスクの承認を混ぜず、再開による run の変更も版の連鎖で追う。
export function collectVersionFamily(artifacts: Row[], artifactId: string): Set<string> {
  const family = new Set([artifactId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const artifact of artifacts) {
      if (family.has(readText(artifact.id))) continue;
      if (family.has(readText(artifact.previous_artifact_id)) || artifacts.some(other => family.has(readText(other.id))
        && (other.previous_artifact_id === artifact.id || other.run_id === artifact.run_id))) {
        family.add(readText(artifact.id)); grew = true;
      }
    }
  }
  return family;
}

export function collectSuccessors(artifacts: Row[], artifactId: string): Set<string> {
  const successors = new Set([artifactId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const artifact of artifacts) {
      if (successors.has(readText(artifact.id))) continue;
      if (successors.has(readText(artifact.previous_artifact_id)) || artifacts.some(previous => successors.has(readText(previous.id))
        && previous.run_id === artifact.run_id && Number(artifact.version) > Number(previous.version))) {
        successors.add(readText(artifact.id)); grew = true;
      }
    }
  }
  return successors;
}

export function staleApprovalText(artifact?: Row, changed?: Row): string {
  const prefix = artifact?.version !== undefined ? `Approved for version ${String(artifact.version)}. ` : '';
  return prefix + (changed?.version !== undefined ? `Version ${String(changed.version)} changed the patch, so this approval no longer applies.` : 'The patch changed, so this approval no longer applies.');
}
