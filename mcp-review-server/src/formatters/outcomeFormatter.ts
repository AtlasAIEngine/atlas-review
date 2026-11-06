import type { OutcomeClearToolData, OutcomeGetToolData, OutcomeSetToolData } from '../types.js';

export function formatOutcomeSetSummary(data: OutcomeSetToolData): string {
  const reviewLabel = data.review.label;
  const lines: string[] = [];

  lines.push(`Project: ${data.project.name}`);
  lines.push(`Review: ${data.review.type} ${reviewLabel}`);
  lines.push(`Outcome: ${data.status}`);
  lines.push(`Recommendation key: ${data.recommendationKey || 'unknown'}`);

  if (!data.telemetry) {
    return lines.join('\n');
  }

  lines.push(
    `Telemetry: total=${data.telemetry.total}, addressed=${data.telemetry.addressed}, dismissed=${data.telemetry.dismissed}`
  );

  return lines.join('\n');
}

export function formatOutcomeGetSummary(data: OutcomeGetToolData): string {
  const lines: string[] = [];
  lines.push(`Project: ${data.project.name}`);
  lines.push(`Review: ${data.review.type} ${data.review.label}`);
  lines.push(`Outcomes: ${data.outcomes.length}`);
  if (data.telemetry) {
    lines.push(
      `Telemetry: total=${data.telemetry.total}, addressed=${data.telemetry.addressed}, dismissed=${data.telemetry.dismissed}`
    );
  }
  return lines.join('\n');
}

export function formatOutcomeClearSummary(data: OutcomeClearToolData): string {
  const lines: string[] = [];
  lines.push(`Project: ${data.project.name}`);
  lines.push(`Review: ${data.review.type} ${data.review.label}`);
  lines.push(`Cleared recommendation key: ${data.recommendationKey}`);
  lines.push(`Deleted outcome: ${data.deletedOutcome ? data.deletedOutcome.status : 'none'}`);
  if (data.telemetry) {
    lines.push(
      `Telemetry: total=${data.telemetry.total}, addressed=${data.telemetry.addressed}, dismissed=${data.telemetry.dismissed}`
    );
  }
  return lines.join('\n');
}
