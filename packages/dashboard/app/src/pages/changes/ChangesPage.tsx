import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { AppLink } from '../../components/AppLink.tsx';
import { Icon } from '../../components/Icon.tsx';
import { AttributionBadge, DiffView } from '../../components/diff/DiffView.tsx';
import { comparePatches, parseDiff, type DiffLayout, type LineLocation } from '../../components/diff/model.ts';
import type { Ack } from '../../lib/client.ts';
import { runLabel, worktreeLabel } from '../../lib/format.ts';
import { store, useScreenStore, type Row, type ScreenStore } from '../../lib/store.ts';
import { collectSuccessors, collectVersionFamily, readAttribution, readObject, readText, readValue, selectArtifacts } from './model.ts';
import './changes.css';

export interface ChangesClient { command(command: string, payload?: unknown, cmdId?: string): Promise<Ack> }
export interface ChangesPageProps { client: ChangesClient; target?: ScreenStore; project?: string; artifactId?: string }
function hasReviewResult(state: ReturnType<ScreenStore['getSnapshot']>, command: string, value: unknown, artifactId: string): boolean {
  const result = readObject(value);
  if (typeof result.review_result_seq === 'number') return state.seq >= result.review_result_seq;
  if (command === 'review.reverify') {
    const artifact = state.projection.artifacts?.find(row => row.id === result.artifactId);
    return Boolean(artifact && JSON.stringify(readValue(artifact.verification)) === JSON.stringify(readValue(result.verification)));
  }
  if (command === 'review.send') {
    return Array.isArray(result.findingIds) && result.findingIds.every(id => state.projection.findings?.some(row =>
      row.id === id && (row.state === 'sent' || row.artifact_id !== artifactId)));
  }
  const table = ['review.add_finding', 'review.finding_state'].includes(command) ? 'findings' : 'approvals';
  return Boolean(result.id && state.projection[table]?.some(row => row.id === result.id
    && (row.state === result.state || ['review.start', 'review.approve', 'review.add_finding'].includes(command))));
}
function Verification({ value }: { value: unknown }) {
  const result = readObject(value);
  const checks = readValue(result.checks ?? result.results);
  return <section className="review-section acceptance-verification" aria-label="Acceptance verification"><h2>Acceptance verification</h2>
    <span className={`chip ${result.passed === false ? 'chip-danger' : result.passed === true ? '' : 'chip-dashed'}`}>
      <Icon name={result.passed === true ? 'check' : result.passed === false ? 'alert' : 'unknown'} size={12}/>
      {result.passed === true ? 'Passed' : result.passed === false ? 'Failed' : 'Unknown · No verification result'}</span>
    {readText(result.reason ?? result.error) && <p>{readText(result.reason ?? result.error)}</p>}
    {Array.isArray(readValue(result.scopeViolations)) && (readValue(result.scopeViolations) as unknown[]).length > 0 && <p>Scope violations: {(readValue(result.scopeViolations) as unknown[]).map(String).join(', ')}</p>}
    {Array.isArray(checks) && checks.map((value, index) => {
      const check = readObject(value);
      return <details key={index}><summary>{readText(check.command ?? check.name) || `Check ${index + 1}`} · {check.passed === true || check.exitCode === 0 || check.exit_code === 0 ? 'Passed' : 'Failed'}</summary>
        <pre>{readText(check.stdout ?? check.output)}{readText(check.stderr)}</pre></details>;
    })}
  </section>;
}
export function ChangesPage({ client, target = store, project, artifactId }: ChangesPageProps) {
  const params = useParams();
  const state = useScreenStore(target);
  const [search] = useSearchParams();
  const projectId = project ?? params.project;
  const allArtifacts = selectArtifacts(state, projectId);
  const runId = search.get('run');
  const runArtifacts = allArtifacts.filter(row => row.run_id === runId);
  const related = new Set(runArtifacts.flatMap(row => [...collectVersionFamily(allArtifacts, readText(row.id))]));
  const artifacts = runId ? allArtifacts.filter(row => related.has(readText(row.id))) : allArtifacts;
  const [chosenId, setChosenId] = useState(artifactId ?? '');
  const artifact = artifacts.find(row => row.id === chosenId) ?? artifacts.findLast(row => !artifacts.some(next => next.previous_artifact_id === row.id)) ?? artifacts.at(-1);
  const id = readText(artifact?.id);
  const [compareId, setCompareId] = useState('');
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const [selectedFile, setSelectedFile] = useState('');
  const [selection, setSelection] = useState<(LineLocation & { artifactId: string })>();
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [selectedFindings, setSelectedFindings] = useState<string[]>([]);
  const [returnedFindings, setReturnedFindings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ artifactId: string; command: string; result: unknown }>();
  const lock = useRef(false);
  useEffect(() => {
    if (notice && (notice.artifactId !== id || hasReviewResult(state, notice.command, notice.result, notice.artifactId))) setNotice(undefined);
  }, [id, notice, state]);
  const patch = readText(artifact?.diff);
  const files = useMemo(() => parseDiff(patch), [patch]);
  const family = collectVersionFamily(artifacts, id);
  const compare = artifacts.find(row => row.id === compareId && family.has(compareId) && compareId !== id);
  const findings = (state.projection.findings ?? []).filter(row => row.artifact_id === id);
  const approvals = (state.projection.approvals ?? []).filter(row => family.has(readText(row.artifact_id)));
  const attribution = readAttribution(artifact?.attribution);
  const evidenceId = `artifact-evidence-${encodeURIComponent(id)}`;
  const evidenceUrl = `#${evidenceId}`;
  const activeSelection = selection?.artifactId === id && !compare ? selection : undefined;
  const sendable = findings.filter(row => selectedFindings.includes(readText(row.id)) && !returnedFindings.includes(JSON.stringify([id, row.id])) && ['open', 'needs_check'].includes(readText(row.state)));
  const enabled = !busy && state.connection === 'connected' && Boolean(artifact);
  const successors = collectSuccessors(artifacts, id);
  const obsolete = artifacts.some(row => successors.has(readText(row.id)) && row.id !== id && row.patch_hash !== artifact?.patch_hash);
  async function command(name: string, payload: unknown, onSuccess?: () => void) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice(undefined);
    try {
      const ack = await client.command(name, payload);
      if (!ack.ok) throw new Error(ack.error ?? 'Review command failed');
      setNotice({ artifactId: id, command: name, result: ack.result }); onSuccess?.();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  function selectLine(location: LineLocation, extend: boolean) {
    setSelection({ ...location, artifactId: id, ...(extend && activeSelection?.file === location.file && activeSelection.side === location.side
      ? { startLine: Math.min(activeSelection.startLine, location.startLine), endLine: Math.max(activeSelection.endLine, location.endLine) } : {}) });
  }
  function selectVersion(value: string) {
    setChosenId(value); setCompareId(''); setSelection(undefined); setSelectedFindings([]); setSelectedFile(''); setBody(''); setNotice(undefined); setError('');
  }
  const artifactRun = state.projection.runs?.find(row => row.id === artifact?.run_id);
  const runPlace = worktreeLabel(artifactRun)?.full;
  const fileHref = projectId ? (path: string) => `/p/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path, ...(runPlace ? { worktree: runPlace } : {}) })}` : undefined;
  const comparisonFiles = compare && typeof compare.diff === 'string' && typeof artifact?.diff === 'string' ? comparePatches(compare.diff, patch) : undefined;
  return <section className="page changes-page" aria-label="Changes and review">
    <header className="page-header"><div className="page-title"><h1>Changes</h1><p className="page-subtitle">Review a fixed artifact version</p></div>
      <div className="button-row"><button className="btn btn-secondary btn-sm" disabled={!enabled || obsolete} onClick={() => void command('review.start', { artifactId: id })}>Start reviewer</button>
        <button className="btn btn-secondary btn-sm" disabled={!enabled || obsolete} onClick={() => void command('review.reverify', { artifactId: id })}><Icon name="play" size={14}/>Reverify</button>
        <button className="btn btn-secondary btn-allow btn-sm" disabled={!enabled || obsolete || approvals.some(row => row.state === 'approved' && row.patch_hash === artifact?.patch_hash)}
          onClick={() => void command('review.approve', { artifactId: id })}><Icon name="check" size={14}/>Approve</button></div></header>
    {projectId && <nav className="tabs" aria-label="Project">
      <AppLink to={`/p/${encodeURIComponent(projectId)}`}>Project</AppLink>
      <AppLink to={`/p/${encodeURIComponent(projectId)}/tree`}>Tree</AppLink>
      <AppLink to={`/p/${encodeURIComponent(projectId)}/changes`} aria-current="page">Changes</AppLink>
      <AppLink to={`/p/${encodeURIComponent(projectId)}/files`}>Files</AppLink>
    </nav>}
    {error && <p role="alert" className="banner banner-danger">{error}</p>}
    {notice?.artifactId === id && !hasReviewResult(state, notice.command, notice.result, notice.artifactId) && <p role="status" className="muted-text">Command accepted; waiting for the updated review.</p>}
    <div className="toolbar changes-toolbar"><div className="inline-field"><label htmlFor="artifact-version">Version</label><select id="artifact-version" value={id} disabled={busy || !artifact} onChange={event => selectVersion(event.target.value)}>
      {artifacts.map(row => <option key={readText(row.id)} value={readText(row.id)}>Version {String(row.version)} · {runLabel(state, row.run_id)}</option>)}</select></div>
      <label className="inline-field">Compare with<select value={compare?.id ? readText(compare.id) : ''} onChange={event => { setCompareId(event.target.value); setSelection(undefined); }}>
        <option value="">Base commit</option>{artifacts.filter(row => family.has(readText(row.id)) && row.id !== id).map(row => <option key={readText(row.id)} value={readText(row.id)}>Version {String(row.version)} · {readText(row.id)}</option>)}</select></label>
      <div className="button-row" role="group" aria-label="Diff layout">{(['unified', 'split'] as const).map(value => <button key={value} className="btn btn-secondary btn-sm" aria-pressed={layout === value}
        onClick={() => setLayout(value)}>{value === 'unified' ? 'Unified' : 'Side by side'}</button>)}</div></div>
    {!artifact ? <div className="empty-state"><Icon name="diff" size={22}/><h2>No artifact versions</h2><p>Changes appear after an execution captures its artifact.</p></div> :
      <div className="changes-columns"><aside className="changes-files" aria-label="Files"><h2>Files <span className="count-pill">{files.length}</span></h2>
        <ul>{files.map(file => <li key={file.path}><button className="changes-file-button" aria-pressed={selectedFile === file.path} onClick={() => { setSelectedFile(file.path); setCompareId(''); }}><Icon name="file" size={14}/><span>{file.path}</span>
          <span className="diff-stat">+{file.additions} −{file.deletions}</span></button>
          <span className="button-row"><AttributionBadge attribution={attribution} evidenceUrl={evidenceUrl}/>
            {fileHref && <AppLink className="btn btn-link btn-xs" to={fileHref(file.path)} aria-label={`Open ${file.path} in Files`} title={`Open ${file.path} in Files`}><Icon name="external" size={12}/>Open in Files</AppLink>}</span></li>)}</ul>
        <details id={evidenceId} className="artifact-evidence"><summary>Artifact evidence</summary><dl>
          {['version', 'repository_id', 'worktree_id', 'base_sha', 'head_sha', 'patch_hash', 'run_id'].map(key => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{String(artifact[key] ?? 'Unknown')}</dd></div>)}</dl>
          <p>{attribution === 'unknown' ? 'Changes whose author could not be identified' : `Attribution: ${attribution}`}</p>
          <AppLink className="btn btn-link" to={`/c/${encodeURIComponent(readText(state.projection.runs?.find(row => row.id === artifact.run_id)?.conversation_id))}`}>Open execution evidence</AppLink></details></aside>
        <section className="changes-diff" aria-label="Difference">
          {compare ? <><h2>Patch comparison · Version {String(compare.version)} → {String(artifact.version)}</h2><p className="muted-text">Comparing saved patch text. Switch to Base commit to comment on artifact lines.</p>
            {comparisonFiles ? comparisonFiles.length ? <DiffView key={`${compare.id}:${id}`} files={comparisonFiles} layout={layout} attribution="unknown" evidenceUrl={evidenceUrl}/> : <p>No patch changes.</p> : <p>Saved diff unavailable for comparison.</p>}</>
            : typeof artifact.diff !== 'string' ? <p className="chip chip-dashed">Saved diff unavailable. Content may not have been retained.</p>
              : files.length ? <DiffView key={id} files={selectedFile ? files.filter(file => file.path === selectedFile) : files} layout={layout} attribution={attribution} evidenceUrl={evidenceUrl} selection={activeSelection} selectedFile={selectedFile} onSelectLine={selectLine} fileHref={fileHref}/>
                : <p>No file changes in this version.</p>}
          {selectedFile && !compare && <button className="btn btn-ghost btn-sm" onClick={() => setSelectedFile('')}>Show all files</button>}
        </section>
        <aside className="changes-review" aria-label="Findings and verification">
          <section className="review-section"><h2>Findings</h2><p className="muted-text">Select a diff line. Shift-select to extend a range.</p>
            {activeSelection && <form onSubmit={event => { event.preventDefault(); const location = activeSelection;
              void command('review.add_finding', { artifactId: id, file: location.file, side: location.side, startLine: location.startLine, endLine: location.endLine, body: body.trim(), severity }, () => { setBody(''); setSelection(undefined); }); }}>
              <p>{activeSelection.file} · {activeSelection.side} · {activeSelection.startLine}–{activeSelection.endLine}</p>
              <label>Finding<textarea required aria-label="Finding" value={body} onChange={event => setBody(event.target.value)}/></label>
              <label>Severity<select value={severity} onChange={event => setSeverity(event.target.value)}>{['low', 'medium', 'high', 'critical'].map(value => <option key={value}>{value}</option>)}</select></label>
              <button className="btn btn-secondary btn-sm" disabled={!enabled || !body.trim()}>Add finding</button></form>}
            <ul className="finding-list">{findings.map(row => <li key={readText(row.id)}>
              <label className="checkbox"><input type="checkbox" aria-label={`Select finding ${readText(row.id)}`} disabled={busy || returnedFindings.includes(JSON.stringify([id, row.id])) || !['open', 'needs_check'].includes(readText(row.state))}
                checked={selectedFindings.includes(readText(row.id))} onChange={event => setSelectedFindings(previous => event.target.checked ? [...previous, readText(row.id)] : previous.filter(id => id !== row.id))}/>{readText(row.file)} · {String(row.start_line)}–{String(row.end_line)} · {readText(row.side)}</label>
              <p>{readText(row.body)}</p><details><summary className={`chip ${row.state === 'needs_check' ? 'chip-attention' : ''}`}>{readText(row.state)} · {readText(row.severity)}</summary><p>Version {String(row.version)} · Context {readText(row.context_hash) || 'Unavailable'}</p></details>
              <div className="button-row">{(row.state === 'fixed' || row.state === 'needs_check') && <button className="btn btn-ghost btn-sm" disabled={!enabled} onClick={() => void command('review.finding_state', { findingId: row.id, state: 'verified' })}>Verify finding</button>}
                {row.state !== 'dismissed' && <button className="btn btn-ghost btn-sm" disabled={!enabled} onClick={() => void command('review.finding_state', { findingId: row.id, state: 'dismissed' })}>Dismiss</button>}</div>
            </li>)}</ul>{!findings.length && <p className="muted-text">No findings for this version.</p>}
            <button className="btn btn-primary btn-sm" disabled={!enabled || !sendable.length} onClick={() => {
              const ids = sendable.map(row => readText(row.id));
              void command('review.send', { artifactId: id, findingIds: ids }, () => { setSelectedFindings([]); setReturnedFindings(previous => [...previous, ...ids.map(findingId => JSON.stringify([id, findingId]))]); });
            }}><Icon name="send" size={14}/>Return selected to agent</button>
          </section>
          <Verification value={artifact.verification}/>
          <section className="review-section" aria-label="Reviewer judgments"><h2>Reviewer judgments and approvals</h2>
            {!approvals.length && <p className="muted-text">No reviewer judgment or approval yet.</p>}
            {approvals.map(row => {
              const request = readObject(row.request); const result = readObject(request.result); const reviewer = readObject(request.reviewer);
              const original = artifacts.find(item => item.id === row.artifact_id);
              const approvalSuccessors = collectSuccessors(artifacts, readText(row.artifact_id));
              const changed = artifacts.findLast(item => approvalSuccessors.has(readText(item.id)) && item.patch_hash !== row.patch_hash);
              const stale = row.state === 'stale';
              return <article className="review-approval" key={readText(row.id)} aria-label={`Approval ${readText(row.id)}`}>
                <details open={stale}><summary className={`chip ${stale || row.state === 'rejected' ? 'chip-attention' : ''}`}><Icon name={stale ? 'alert' : row.state === 'approved' ? 'check' : 'x'} size={12}/>{stale ? 'Stale · Invalid approval' : readText(row.state)}</summary>
                  <p>Version {String(original?.version ?? 'Unknown')} · Patch {readText(row.patch_hash).slice(0, 8)}</p>{!stale && readText(row.reason) && <p>{readText(row.reason)}</p>}</details>
                {readText(result.verdict) && <p>Reviewer: {readText(reviewer.executor ?? reviewer.provider)} {readText(reviewer.model)}{readText(reviewer.family) ? ` (${readText(reviewer.family)})` : ''} · {readText(result.verdict)}</p>}
                {readText(result.comment) && <p>{readText(result.comment)}</p>}
                {readText(request.reviewer_run_id) && <AppLink className="btn btn-link" to={`/c/${encodeURIComponent(readText(state.projection.runs?.find(run => run.id === request.reviewer_run_id)?.conversation_id))}`}>Reviewer evidence</AppLink>}
                {stale && <div className="stale-comparison"><p>Approved for version {String(original?.version ?? 'Unknown')}. {changed ? `Version ${String(changed.version)} changed the patch, so this approval no longer applies.` : 'The patch changed, so this approval no longer applies.'}</p>
                  <div className="stale-hashes"><code>Approved: {readText(row.patch_hash).slice(0, 8)}</code><code>Changed: {readText(changed?.patch_hash).slice(0, 8) || 'Unavailable'}</code></div>
                  {typeof original?.diff === 'string' && typeof changed?.diff === 'string' ? <DiffView files={comparePatches(original.diff, changed.diff)} layout="split" attribution="unknown" evidenceUrl={evidenceUrl}/>
                    : <p>Saved diff unavailable for stale comparison.</p>}</div>}
                {['approved', 'stale'].includes(readText(row.state)) && <button className="btn btn-secondary btn-sm" disabled={!enabled} onClick={() => void command('review.revoke', { approvalId: row.id })}>Revoke approval</button>}
              </article>;
            })}</section>
        </aside></div>}
  </section>;
}
export default ChangesPage;
