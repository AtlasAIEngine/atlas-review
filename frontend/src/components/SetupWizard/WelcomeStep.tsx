/**
 * WelcomeStep Component
 * Step 1: Atlas Review introduction
 */

import { useEffect, useMemo, useState } from 'react';
import { SETUP_PRIMARY_FILL, getSetupButtonStyle } from './setupChrome';
import { SetupButtonIcon } from './setupButtonIcons';
import { isSetupAdvanceKey, shouldIgnoreSetupShortcut } from './setupKeyboard';

interface WelcomeStepProps {
  onNext: () => void;
}

const WORKFLOW_ROWS = [
  {
    type: 'plain' as const,
    text: 'Add your project to Atlas',
  },
  {
    type: 'review' as const,
    prefix: 'Press',
    suffix: 'or tell your agent',
    command: '"Use Atlas review to find issues and fix them."',
  },
  {
    type: 'plain' as const,
    text: 'Commit and push.',
  },
  {
    type: 'plain' as const,
    text: 'Repeat.',
  },
];

const ROW_REVEAL_DELAY_MS = 280;
const CHAR_TYPING_DELAY_MS = 22;
const NEXT_ROW_DELAY_MS = 700;

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  const [visibleRowCount, setVisibleRowCount] = useState(0);
  const [typedCharCount, setTypedCharCount] = useState(0);
  const [activeRowIndex, setActiveRowIndex] = useState(0);
  const [animationDone, setAnimationDone] = useState(false);

  const getRowTypingLength = (row: (typeof WORKFLOW_ROWS)[number]) => {
    if (row.type === 'plain') return row.text.length;
    return `${row.prefix} ${row.suffix} ${row.command}`.length;
  };

  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) {
      setVisibleRowCount(WORKFLOW_ROWS.length);
      setActiveRowIndex(WORKFLOW_ROWS.length - 1);
      setTypedCharCount(getRowTypingLength(WORKFLOW_ROWS[WORKFLOW_ROWS.length - 1]));
      setAnimationDone(true);
      return undefined;
    }

    let cancelled = false;
    const timeouts: number[] = [];

    const runSequence = (rowIndex: number) => {
      if (cancelled || rowIndex >= WORKFLOW_ROWS.length) {
        if (!cancelled) setAnimationDone(true);
        return;
      }

      setActiveRowIndex(rowIndex);
      setVisibleRowCount(rowIndex + 1);
      setTypedCharCount(0);

      const rowTextLength = getRowTypingLength(WORKFLOW_ROWS[rowIndex]);

      for (let index = 1; index <= rowTextLength; index += 1) {
        timeouts.push(
          window.setTimeout(() => {
            if (!cancelled) {
              setTypedCharCount(index);
            }
          }, ROW_REVEAL_DELAY_MS + index * CHAR_TYPING_DELAY_MS)
        );
      }

      const nextDelay = ROW_REVEAL_DELAY_MS + rowTextLength * CHAR_TYPING_DELAY_MS + NEXT_ROW_DELAY_MS;
      timeouts.push(
        window.setTimeout(() => {
          runSequence(rowIndex + 1);
        }, nextDelay)
      );
    };

    runSequence(0);

    return () => {
      cancelled = true;
      timeouts.forEach((timeout) => window.clearTimeout(timeout));
    };
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (!animationDone) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreSetupShortcut(event) || !isSetupAdvanceKey(event)) {
        return;
      }

      event.preventDefault();
      onNext();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [animationDone, onNext]);

  return (
    <div className="text-center">
      <h1 className="text-[1.75rem] md:text-[2.2rem] font-bold mb-2" style={{ color: 'var(--text-primary)', letterSpacing: '-0.04em' }}>
        Review every commit before you push
      </h1>

      <p
        className="mx-auto mb-5 max-w-2xl text-xs md:text-sm"
        style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
      >
        A simple workflow you can run every time.
      </p>

      <div className="mx-auto mb-6 max-w-4xl text-left">
        <div
          style={{
            background: 'var(--review-card-bg)',
            border: '1px solid var(--review-shell-border)',
            borderRadius: 16,
            boxShadow: 'var(--review-panel-shadow)',
            overflow: 'hidden',
          }}
        >
          <div>
          {WORKFLOW_ROWS.map((row, index) => {
            const isVisible = index < visibleRowCount;
            const isActive = index === activeRowIndex;
            const isComplete = index < activeRowIndex;
            const typedText = row.type === 'plain'
              ? isComplete
                ? row.text
                : isActive
                  ? row.text.slice(0, typedCharCount)
                  : ''
              : null;

            const reviewPrefixLength = row.type === 'review' ? row.prefix.length : 0;
            const reviewSuffixLength = row.type === 'review' ? row.suffix.length : 0;
            const reviewCommandLength = row.type === 'review' ? row.command.length : 0;
            const visiblePrefixChars = row.type === 'review'
              ? isComplete
                ? reviewPrefixLength
                : isActive
                  ? Math.min(typedCharCount, reviewPrefixLength)
                  : 0
              : 0;
            const prefixDone = visiblePrefixChars >= reviewPrefixLength;
            const visibleSuffixChars = row.type === 'review'
              ? isComplete
                ? reviewSuffixLength
                : isActive
                  ? Math.min(Math.max(typedCharCount - reviewPrefixLength, 0), reviewSuffixLength)
                  : 0
              : 0;
            const visibleCommandChars = row.type === 'review'
              ? isComplete
                ? reviewCommandLength
                : isActive
                  ? Math.min(Math.max(typedCharCount - reviewPrefixLength - reviewSuffixLength, 0), reviewCommandLength)
                  : 0
              : 0;

            return (
              <div
                key={row.type === 'plain' ? row.text : row.command}
                className="flex items-center gap-6"
                style={{
                  minHeight: 68,
                  padding: '0 22px 0 24px',
                  opacity: isVisible ? 1 : 0,
                  transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
                  transition: 'opacity 260ms ease, transform 320ms ease',
                  borderTop: index === 0 ? 'none' : '1px solid var(--review-shell-divider)',
                }}
              >
                <div
                  className="flex h-8 min-w-8 items-center justify-center rounded-full text-[1.05rem] font-semibold"
                  style={{
                    position: 'relative',
                    zIndex: 1,
                    background: isActive
                      ? `color-mix(in srgb, ${SETUP_PRIMARY_FILL} 18%, rgba(255,255,255,0.02))`
                      : 'color-mix(in srgb, var(--review-shell-bg) 48%, var(--review-card-bg))',
                    border: `1px solid ${
                      isActive
                        ? `color-mix(in srgb, ${SETUP_PRIMARY_FILL} 58%, var(--review-shell-border))`
                        : 'var(--review-shell-border)'
                    }`,
                    color: isActive ? SETUP_PRIMARY_FILL : 'var(--text-tertiary)',
                    boxShadow: isActive ? `0 0 0 3px color-mix(in srgb, ${SETUP_PRIMARY_FILL} 16%, transparent)` : 'none',
                    transition: 'background 200ms ease, border-color 200ms ease, color 200ms ease, box-shadow 200ms ease',
                  }}
                >
                  {index + 1}
                </div>

                <div
                  className="min-h-8 flex-1"
                  style={{
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    lineHeight: 1.5,
                    letterSpacing: '-0.01em',
                    transition: 'color 200ms ease',
                    fontSize: 'clamp(14px, 1.08vw, 18px)',
                    fontWeight: 600,
                  }}
                >
                  {row.type === 'plain' && <span>{typedText}</span>}

                  {row.type === 'review' && (
                    <span
                      className="inline-flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-2"
                      style={{ whiteSpace: 'normal' }}
                    >
                      {visiblePrefixChars > 0 && (
                        <span>{row.prefix.slice(0, visiblePrefixChars)}</span>
                      )}

                      {prefixDone && (
                        <span
                          className="inline-flex items-center gap-1.5"
                          style={{
                            ...getSetupButtonStyle({ tone: 'blue', active: true, compact: true }),
                            minHeight: 28,
                            fontSize: 10.5,
                            fontWeight: 600,
                            transform: 'translateY(-1px)',
                          }}
                        >
                          <SetupButtonIcon name="sparkles" size={12} />
                          Run Review
                        </span>
                      )}

                      {visibleSuffixChars > 0 && (
                        <span>{row.suffix.slice(0, visibleSuffixChars)}</span>
                      )}

                      {visibleCommandChars > 0 && (
                        <span
                          style={{
                            color: SETUP_PRIMARY_FILL,
                            background: `color-mix(in srgb, ${SETUP_PRIMARY_FILL} 12%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${SETUP_PRIMARY_FILL} 38%, var(--review-shell-border))`,
                            borderRadius: 10,
                            padding: '5px 10px',
                            fontWeight: 700,
                            fontSize: '0.74em',
                            boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${SETUP_PRIMARY_FILL} 12%, transparent)`,
                          }}
                        >
                          {row.command.slice(0, visibleCommandChars)}
                        </span>
                      )}
                    </span>
                  )}

                  {isActive && typedCharCount < getRowTypingLength(row) && (
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-block',
                        width: 8,
                        marginLeft: 2,
                        color: SETUP_PRIMARY_FILL,
                        animation: 'atlas-setup-caret 1s steps(1) infinite',
                      }}
                    >
                      |
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </div>

      <div
        className="flex flex-col items-center gap-3"
        style={{
          opacity: animationDone ? 1 : 0,
          transform: animationDone ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity 400ms ease, transform 400ms ease',
          pointerEvents: animationDone ? 'auto' : 'none',
        }}
      >
        <button
          onClick={onNext}
          style={{
            ...getSetupButtonStyle({ tone: 'blue', active: true }),
          }}
        >
          <SetupButtonIcon name="sparkles" size={16} />
          Get Started
        </button>
      </div>

      <style>{`
        @keyframes atlas-setup-caret {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

export default WelcomeStep;
