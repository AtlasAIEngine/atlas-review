/**
 * BranchReviewScopeControls — Scope include/exclude pattern inputs.
 * Extracted from TrustReviewPanel.tsx.
 */

import { parseScopePatterns, buildScopeStatusLabel } from './reviewPanelUtils';

export function BranchReviewScopeControls({
  includeValue,
  excludeValue,
  onIncludeChange,
  onExcludeChange,
  applyGlobalIgnorePatterns,
  onApplyGlobalIgnorePatternsChange,
  globalIgnorePatternCount,
  disabled,
  showHint,
}: {
  includeValue: string;
  excludeValue: string;
  onIncludeChange: (value: string) => void;
  onExcludeChange: (value: string) => void;
  applyGlobalIgnorePatterns: boolean;
  onApplyGlobalIgnorePatternsChange: (value: boolean) => void;
  globalIgnorePatternCount: number;
  disabled: boolean;
  showHint: boolean;
}) {
  const includeCount = parseScopePatterns(includeValue).length;
  const excludeCount = parseScopePatterns(excludeValue).length;
  const statusLabel = buildScopeStatusLabel({
    includeCount,
    excludeCount,
    applyGlobalIgnorePatterns,
    globalIgnorePatternCount,
  });

  return (
    <div style={{
      background: 'rgba(24, 31, 43, 0.94)',
      borderRadius: 10,
      padding: '8px 10px',
      marginBottom: 0,
      border: '1px solid var(--review-shell-border)',
      boxShadow: '0 10px 24px rgba(3, 7, 14, 0.18)',
    }}>
      <div style={{
        marginBottom: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
          Scope settings
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
          {statusLabel}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          color: 'var(--text-secondary)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          fontWeight: 500,
        }}>
          <input
            type="checkbox"
            checked={applyGlobalIgnorePatterns}
            onChange={(e) => onApplyGlobalIgnorePatternsChange(e.target.checked)}
            disabled={disabled}
            style={{ accentColor: 'var(--accent-blue)', width: 13, height: 13 }}
          />
          <span>
            Apply global ignore patterns ({globalIgnorePatternCount})
          </span>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
            Include paths/patterns (comma or newline)
          </span>
          <textarea
            value={includeValue}
            onChange={(e) => onIncludeChange(e.target.value)}
            placeholder="src/**/*.ts, backend/src/routes/*"
            disabled={disabled}
            rows={2}
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 42,
              background: 'rgba(8, 12, 20, 0.96)',
              color: 'var(--text-primary)',
              border: '1px solid rgba(80, 95, 124, 0.34)',
              borderRadius: 7,
              padding: '6px 8px',
              fontSize: 10,
              lineHeight: 1.25,
              fontFamily: 'var(--font-mono)',
              opacity: disabled ? 0.6 : 1,
              boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.02)',
            }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
            Exclude paths/patterns
          </span>
          <textarea
            value={excludeValue}
            onChange={(e) => onExcludeChange(e.target.value)}
            placeholder="**/*.md, docs/**, **/*.lock"
            disabled={disabled}
            rows={2}
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 42,
              background: 'rgba(8, 12, 20, 0.96)',
              color: 'var(--text-primary)',
              border: '1px solid rgba(80, 95, 124, 0.34)',
              borderRadius: 7,
              padding: '6px 8px',
              fontSize: 10,
              lineHeight: 1.25,
              fontFamily: 'var(--font-mono)',
              opacity: disabled ? 0.6 : 1,
              boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.02)',
            }}
          />
        </label>
        {showHint && (
          <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
            Large branch detected. Scope controls can reduce review time and improve relevance.
          </div>
        )}
      </div>
    </div>
  );
}
