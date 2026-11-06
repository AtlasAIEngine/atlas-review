import type { FileToolData, LatestToolData } from '../types.js';

function describeReviewType(reviewType: string): string {
  if (reviewType === 'pr_review') return 'PR review';
  if (reviewType === 'workspace_review') return 'Workspace review';
  return 'Branch review';
}

export function formatLatestSummary(data: LatestToolData): string {
  const reviewLabel = data.review.label;
  const lines: string[] = [];

  lines.push(`Project: ${data.project.name}`);
  lines.push(`${describeReviewType(data.review.type)}: ${reviewLabel}`);
  lines.push(`Risk level: ${data.riskLevel}`);
  lines.push(`Summary: ${data.summary || 'No summary available.'}`);

  if (!data.findings.length) {
    lines.push('Top findings: none');
    return lines.join('\n');
  }

  lines.push('Top findings:');
  for (const finding of data.findings.slice(0, 5)) {
    const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : 'unknown location';
    const carried = finding.previousFinding ? ' previous' : '';
    lines.push(`- ${finding.findingId} [${finding.severity}${carried}] ${finding.title} (${location})`);
  }

  return lines.join('\n');
}

export function formatFileSummary(data: FileToolData): string {
  const reviewLabel = data.review.label;
  const lines: string[] = [];

  lines.push(`Project: ${data.project.name}`);
  lines.push(`${describeReviewType(data.review.type)}: ${reviewLabel}`);
  lines.push(`File: ${data.path}`);

  if (!data.fileInScope) {
    lines.push('Diff scope: missing');
    lines.push('Findings: unavailable (file is outside current diff scope)');
    return lines.join('\n');
  }

  const status = data.file?.status ? ` (${data.file.status})` : '';
  lines.push(`Diff scope: present${status}`);

  if (!data.findings.length) {
    lines.push('Findings: none');
    return lines.join('\n');
  }

  lines.push(`Findings: ${data.findings.length} matched`);
  for (const finding of data.findings.slice(0, 5)) {
    const location = finding.line ? `:${finding.line}` : '';
    const carried = finding.previousFinding ? ' previous' : '';
    lines.push(`- ${finding.findingId} [${finding.severity}${carried}] ${finding.title}${location}`);
  }

  return lines.join('\n');
}
