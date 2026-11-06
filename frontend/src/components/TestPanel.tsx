/**
 * Test Panel Component
 * Manages automated tests for preview panel
 */

import { useState, useEffect } from 'react';
import toast from '@/lib/toast';
import { testApi, screenshotApi } from '@/services/api';
import type { TestCase, TestStep, TestAction, StepResult, TestResult, RecordedAction } from '@/types';
import { usePopup } from './shared/PopupProvider';

interface TestPanelProps {
  projectId: string;
  onRunTest: (test: TestCase) => void;
  onStopTest: () => void;
  onPickElement: (stepIndex: number) => void;
  onCancelPick: () => void;
  onValidateSelector: (selector: string, stepIndex: number) => void;
  isRunning: boolean;
  currentStepIndex: number | null;
  stepResults: StepResult[];
  lastTestResult: TestResult | null;
  selectorValidation: { stepIndex: number; matches: boolean; count: number } | null;
  pickingStepIndex: number | null;
  // Recording props
  isRecording: boolean;
  recordedSteps: RecordedAction[];
  onStartRecording: () => void;
  onStopRecording: () => void;
  onClearRecording: () => void;
}

const ACTION_OPTIONS: { value: TestAction; label: string }[] = [
  { value: 'click', label: 'Click' },
  { value: 'type', label: 'Type' },
  { value: 'navigate', label: 'Navigate' },
  { value: 'assert', label: 'Assert' },
  { value: 'screenshot', label: 'Screenshot' },
];

function TestPanel({
  projectId,
  onRunTest,
  onStopTest,
  onPickElement,
  onCancelPick,
  onValidateSelector,
  isRunning,
  currentStepIndex,
  stepResults,
  lastTestResult,
  selectorValidation,
  pickingStepIndex,
  isRecording,
  recordedSteps,
  onStartRecording,
  onStopRecording,
  onClearRecording,
}: TestPanelProps) {
  const popup = usePopup();
  const [tests, setTests] = useState<TestCase[]>([]);
  const [selectedTest, setSelectedTest] = useState<TestCase | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editingTest, setEditingTest] = useState<{ name: string; steps: TestStep[] }>({
    name: '',
    steps: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<string | null>(null); // stores test ID being deleted
  const [visualDiffModal, setVisualDiffModal] = useState<{
    stepIndex: number;
    testId: string;
    currentImage: string;
    baselineImage?: string;
    diffImage?: string;
    matchPercentage: number;
    noBaseline: boolean;
  } | null>(null);
  const [settingBaseline, setSettingBaseline] = useState<number | null>(null); // step index being set as baseline
  const [runningTestId, setRunningTestId] = useState<string | null>(null); // track which test is running for screenshot ops
  const [processedScreenshots, setProcessedScreenshots] = useState<Set<number>>(new Set()); // track which screenshots have been shown

  // Load tests when projectId changes
  useEffect(() => {
    if (projectId) {
      loadTests();
    }
  }, [projectId]);

  // Listen for element picked events from PreviewPanel
  useEffect(() => {
    const handleElementPicked = (event: CustomEvent<{ stepIndex: number; selector: string }>) => {
      const { stepIndex, selector } = event.detail;
      console.log('[TestPanel] Received element picked event:', { stepIndex, selector, isEditing, stepsLength: editingTest.steps.length });
      if (isEditing && stepIndex >= 0 && stepIndex < editingTest.steps.length) {
        const newSteps = [...editingTest.steps];
        newSteps[stepIndex] = { ...newSteps[stepIndex], selector };
        console.log('[TestPanel] Updating step with selector:', newSteps[stepIndex]);
        setEditingTest({ ...editingTest, steps: newSteps });
        toast.success(`Selector captured for step ${stepIndex + 1}`);
      } else {
        console.warn('[TestPanel] Element picked event ignored - conditions not met:', { isEditing, stepIndex, stepsLength: editingTest.steps.length });
      }
    };

    window.addEventListener('atlas-test-element-picked', handleElementPicked as EventListener);
    return () => {
      window.removeEventListener('atlas-test-element-picked', handleElementPicked as EventListener);
    };
  }, [isEditing, editingTest]);

  // Process screenshot results when they come in - queue-based processing
  useEffect(() => {
    // Skip if modal is already open (wait for user to close it)
    if (visualDiffModal) return;

    const screenshotResults = stepResults.filter(r => r.screenshotData?.imageData);

    // Find first unprocessed screenshot
    const unprocessed = screenshotResults.find(r => !processedScreenshots.has(r.stepIndex));

    if (unprocessed && unprocessed.screenshotData) {
      // Mark as processed before showing modal
      setProcessedScreenshots(prev => new Set(prev).add(unprocessed.stepIndex));
      handleScreenshotResult(unprocessed.stepIndex, unprocessed.screenshotData as {
        imageData: string;
        name?: string;
        threshold?: number;
      });
    }
  }, [stepResults, runningTestId, projectId, visualDiffModal, processedScreenshots]);

  // Clear runningTestId when test completes AND all screenshots are processed
  useEffect(() => {
    if (!isRunning && runningTestId) {
      // Check if there are unprocessed screenshots
      const screenshotResults = stepResults.filter(r => r.screenshotData?.imageData);
      const hasUnprocessedScreenshots = screenshotResults.some(r => !processedScreenshots.has(r.stepIndex));

      // Don't clear if there are still screenshots to process or modal is open
      if (hasUnprocessedScreenshots || visualDiffModal) {
        return;
      }

      // Delay clearing to allow any final processing
      const timeout = setTimeout(() => {
        setRunningTestId(null);
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [isRunning, runningTestId, stepResults, processedScreenshots, visualDiffModal]);

  const loadTests = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await testApi.list(projectId);
      setTests(response.tests);
    } catch (error) {
      console.error('Failed to load tests:', error);
      setLoadError('Failed to load tests. Please try again.');
      toast.error('Failed to load tests');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateNew = () => {
    setSelectedTest(null);
    setEditingTest({
      name: 'New Test',
      steps: [{ action: 'click', selector: '' }],
    });
    setIsEditing(true);
  };

  const handleEditTest = (test: TestCase) => {
    setSelectedTest(test);
    setEditingTest({
      name: test.name,
      steps: [...test.steps],
    });
    setIsEditing(true);
  };

  const handleSaveTest = async () => {
    if (!editingTest.name.trim()) {
      toast.error('Test name is required');
      return;
    }

    if (editingTest.steps.length === 0) {
      toast.error('At least one step is required');
      return;
    }

    // Validate steps
    for (let i = 0; i < editingTest.steps.length; i++) {
      const step = editingTest.steps[i];
      if ((step.action === 'click' || step.action === 'type' || step.action === 'assert') && !step.selector?.trim()) {
        toast.error(`Selector is required for step ${i + 1}`);
        return;
      }
      if (step.action === 'type' && !step.value?.trim()) {
        toast.error(`Value is required for type step ${i + 1}`);
        return;
      }
      if (step.action === 'navigate' && !step.value?.trim()) {
        toast.error(`URL is required for navigate step ${i + 1}`);
        return;
      }
    }

    setIsSaving(true);
    try {
      if (selectedTest) {
        // Update existing test
        const response = await testApi.update(projectId, selectedTest.id, editingTest);
        setTests(tests.map(t => t.id === selectedTest.id ? response.test : t));
        toast.success('Test updated');
      } else {
        // Create new test
        const response = await testApi.create(projectId, editingTest);
        setTests([response.test, ...tests]);
        toast.success('Test created');
      }
      setIsEditing(false);
      setSelectedTest(null);
    } catch (error: any) {
      console.error('Failed to save test:', error);
      toast.error(error.response?.data?.error || 'Failed to save test');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteTest = async (test: TestCase) => {
    const confirmed = await popup.confirm({
      title: 'Delete Test?',
      message: `Delete test "${test.name}"? This action cannot be undone.`,
      confirmLabel: 'Delete test',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;

    setIsDeleting(test.id);
    try {
      await testApi.delete(projectId, test.id);
      setTests(tests.filter(t => t.id !== test.id));
      if (selectedTest?.id === test.id) {
        setSelectedTest(null);
        setIsEditing(false);
      }
      toast.success('Test deleted');
    } catch (error) {
      console.error('Failed to delete test:', error);
      toast.error('Failed to delete test');
    } finally {
      setIsDeleting(null);
    }
  };

  const handleAddStep = () => {
    setEditingTest({
      ...editingTest,
      steps: [...editingTest.steps, { action: 'click', selector: '' }],
    });
  };

  // Convert recorded actions to test steps
  const convertRecordedToSteps = (recorded: RecordedAction[]): TestStep[] => {
    return recorded.map((action) => ({
      action: action.action,
      selector: action.selector || '',
      value: action.value || '',
    }));
  };

  // Create test from recording
  const handleCreateFromRecording = () => {
    if (recordedSteps.length === 0) {
      toast.error('No actions recorded');
      return;
    }

    const steps = convertRecordedToSteps(recordedSteps);
    setSelectedTest(null);
    setEditingTest({
      name: 'Recorded Test',
      steps,
    });
    setIsEditing(true);
    onClearRecording();
    toast.success(`Created test with ${steps.length} step(s)`);
  };

  // Get action description for display
  const getActionDescription = (action: RecordedAction): string => {
    const elemInfo = action.elementInfo;
    const tag = elemInfo?.tagName || 'element';
    const text = elemInfo?.text ? ` "${elemInfo.text.substring(0, 20)}${elemInfo.text.length > 20 ? '...' : ''}"` : '';
    const type = elemInfo?.type ? ` [${elemInfo.type}]` : '';

    switch (action.action) {
      case 'click':
        return `Click ${tag}${text}${type}`;
      case 'type':
        return `Type "${action.value?.substring(0, 20)}${(action.value?.length || 0) > 20 ? '...' : ''}" into ${tag}`;
      case 'navigate':
        return `Navigate to ${action.value}`;
      default:
        return `${action.action} ${tag}`;
    }
  };

  const handleRemoveStep = (index: number) => {
    setEditingTest({
      ...editingTest,
      steps: editingTest.steps.filter((_, i) => i !== index),
    });
  };

  const handleStepChange = (index: number, field: keyof TestStep, value: string) => {
    const newSteps = [...editingTest.steps];
    newSteps[index] = { ...newSteps[index], [field]: value };
    setEditingTest({ ...editingTest, steps: newSteps });
  };

  const handleRunTest = (test: TestCase) => {
    setRunningTestId(test.id);
    setProcessedScreenshots(new Set()); // Reset processed screenshots for new test run
    onRunTest(test);
  };

  // Handle screenshot comparison and visual diff display
  const handleScreenshotResult = async (stepIndex: number, screenshotData: {
    imageData: string;
    name?: string;
    threshold?: number;
  }) => {
    if (!runningTestId) return;

    try {
      // Compare screenshot against baseline
      const threshold = (screenshotData.threshold || 0.1) / 100; // Convert percentage to decimal
      const result = await screenshotApi.compareScreenshot(
        projectId,
        runningTestId,
        stepIndex,
        screenshotData.imageData,
        threshold
      );

      const comparison = result.comparison;

      setVisualDiffModal({
        stepIndex,
        testId: runningTestId,
        currentImage: screenshotData.imageData,
        baselineImage: comparison.baselineImageData,
        diffImage: comparison.diffImageData,
        matchPercentage: comparison.matchPercentage,
        noBaseline: comparison.noBaseline || false,
      });
    } catch (error) {
      console.error('Failed to compare screenshot:', error);
      toast.error('Failed to compare screenshot');
    }
  };

  // Set current screenshot as baseline
  const handleSetBaseline = async () => {
    if (!visualDiffModal) return;

    setSettingBaseline(visualDiffModal.stepIndex);
    try {
      await screenshotApi.setBaseline(
        projectId,
        visualDiffModal.testId,
        visualDiffModal.stepIndex,
        visualDiffModal.currentImage
      );
      toast.success('Baseline set successfully');
      setVisualDiffModal(null);
    } catch (error) {
      console.error('Failed to set baseline:', error);
      toast.error('Failed to set baseline');
    } finally {
      setSettingBaseline(null);
    }
  };

  const getStepResultIcon = (stepIndex: number) => {
    const result = stepResults.find(r => r.stepIndex === stepIndex);
    if (!result) {
      if (currentStepIndex === stepIndex) {
        return (
          <svg className="w-4 h-4 text-accent-blue animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        );
      }
      return null;
    }
    if (result.status === 'pass') {
      return (
        <svg className="w-4 h-4 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      );
    }
    if (result.status === 'fail') {
      return (
        <svg className="w-4 h-4 text-accent-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
    }
    return (
      <svg className="w-4 h-4 text-content-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
      </svg>
    );
  };

  const getSelectorValidationIcon = (stepIndex: number) => {
    if (!selectorValidation || selectorValidation.stepIndex !== stepIndex) return null;

    if (selectorValidation.matches) {
      return (
        <span className="text-accent-green text-xs ml-1" title={`Found ${selectorValidation.count} element(s)`}>
          ({selectorValidation.count})
        </span>
      );
    }
    return (
      <span className="text-accent-red text-xs ml-1" title="No elements found">
        (0)
      </span>
    );
  };

  return (
    <div className="h-full bg-surface flex flex-col">

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isEditing ? (
          /* Test Editor */
          <div className="p-3 space-y-4">
            <div>
              <label className="block text-xs text-content-secondary mb-1">Test Name</label>
              <input
                type="text"
                value={editingTest.name}
                onChange={(e) => setEditingTest({ ...editingTest, name: e.target.value })}
                className="w-full bg-surface border border-border-strong rounded px-3 py-2 text-sm text-content focus:outline-none focus:border-accent-blue"
                placeholder="Enter test name"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-content-secondary">Steps</label>
                <button
                  onClick={handleAddStep}
                  className="text-xs text-accent-blue hover:text-accent-blue"
                >
                  + Add Step
                </button>
              </div>

              <div className="space-y-3">
                {editingTest.steps.map((step, index) => (
                  <div key={index} className="bg-surface rounded p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-content-tertiary">Step {index + 1}</span>
                      <button
                        onClick={() => handleRemoveStep(index)}
                        className="text-content-tertiary hover:text-accent-red"
                        title="Remove step"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>

                    <select
                      value={step.action}
                      onChange={(e) => handleStepChange(index, 'action', e.target.value)}
                      className="w-full bg-surface-elevated border border-border-strong rounded px-2 py-1 text-sm text-content focus:outline-none focus:border-accent-blue"
                    >
                      {ACTION_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>

                    {(step.action === 'click' || step.action === 'type' || step.action === 'assert') && (
                      <div className="space-y-1">
                        <input
                          type="text"
                          value={step.selector || ''}
                          onChange={(e) => handleStepChange(index, 'selector', e.target.value)}
                          className="w-full bg-surface-elevated border border-border-strong rounded px-2 py-1 text-sm text-content focus:outline-none focus:border-accent-blue"
                          placeholder="CSS selector"
                        />
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => pickingStepIndex === index ? onCancelPick() : onPickElement(index)}
                            className={`flex-1 px-2 py-1 rounded text-xs text-content ${
                              pickingStepIndex === index
                                ? 'bg-orange-500 hover:bg-orange-600'
                                : 'bg-accent-blue hover:bg-accent-blue/80'
                            }`}
                            title={pickingStepIndex === index ? "Cancel element selection" : "Pick element from preview"}
                          >
                            {pickingStepIndex === index ? 'Cancel' : 'Pick'}
                          </button>
                          <button
                            onClick={() => step.selector?.trim() && onValidateSelector(step.selector.trim(), index)}
                            className="flex-1 px-2 py-1 bg-surface-elevated hover:bg-surface-hover rounded text-xs text-content disabled:opacity-50"
                            title="Validate selector"
                            disabled={!step.selector?.trim()}
                          >
                            Test
                          </button>
                          {getSelectorValidationIcon(index)}
                        </div>
                      </div>
                    )}

                    {step.action === 'type' && (
                      <input
                        type="text"
                        value={step.value || ''}
                        onChange={(e) => handleStepChange(index, 'value', e.target.value)}
                        className="w-full bg-surface-elevated border border-border-strong rounded px-2 py-1 text-sm text-content focus:outline-none focus:border-accent-blue"
                        placeholder="Text to type"
                      />
                    )}

                    {step.action === 'navigate' && (
                      <input
                        type="text"
                        value={step.value || ''}
                        onChange={(e) => handleStepChange(index, 'value', e.target.value)}
                        className="w-full bg-surface-elevated border border-border-strong rounded px-2 py-1 text-sm text-content focus:outline-none focus:border-accent-blue"
                        placeholder="URL (e.g., /about)"
                      />
                    )}

                    {step.action === 'assert' && (
                      <input
                        type="text"
                        value={step.expected || ''}
                        onChange={(e) => handleStepChange(index, 'expected', e.target.value)}
                        className="w-full bg-surface-elevated border border-border-strong rounded px-2 py-1 text-sm text-content focus:outline-none focus:border-accent-blue"
                        placeholder="Expected text content"
                      />
                    )}

                    {step.action === 'screenshot' && (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={step.screenshotName || ''}
                          onChange={(e) => handleStepChange(index, 'screenshotName', e.target.value)}
                          className="w-full bg-surface-elevated border border-border-strong rounded px-2 py-1 text-sm text-content focus:outline-none focus:border-accent-blue"
                          placeholder="Screenshot name (e.g., homepage, login-form)"
                        />
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-content-secondary">Threshold:</label>
                          <input
                            type="number"
                            value={step.threshold !== undefined ? step.threshold : 0.1}
                            onChange={(e) => handleStepChange(index, 'threshold', e.target.value)}
                            min="0"
                            max="100"
                            step="0.1"
                            className="w-20 bg-surface-elevated border border-border-strong rounded px-2 py-1 text-sm text-content focus:outline-none focus:border-accent-blue"
                          />
                          <span className="text-xs text-content-secondary">% diff tolerance</span>
                        </div>
                        <p className="text-xs text-content-tertiary">
                          Captures a screenshot of the viewport for visual comparison
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Editor Actions */}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onCancelPick(); // Cancel any active element picking
                  setIsEditing(false);
                  setSelectedTest(null);
                }}
                className="flex-1 px-3 py-2 bg-surface-elevated hover:bg-surface-hover rounded text-sm text-content"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTest}
                disabled={isSaving}
                className="flex-1 px-3 py-2 bg-accent-blue hover:bg-accent-blue/80 disabled:bg-surface-overlay rounded text-sm text-content"
              >
                {isSaving ? 'Saving...' : 'Save Test'}
              </button>
            </div>
          </div>
        ) : (
          /* Test List */
          <div className="p-3">
            {/* Record/New Test buttons */}
            <div className="flex gap-2 mb-4">
              {isRecording ? (
                <button
                  onClick={onStopRecording}
                  className="flex-1 px-3 py-2 bg-accent-red hover:bg-accent-red/80 rounded text-sm text-content flex items-center justify-center gap-2"
                >
                  <span className="w-2 h-2 bg-surface-raised rounded-full animate-pulse"></span>
                  Stop Recording
                </button>
              ) : (
                <button
                  onClick={onStartRecording}
                  disabled={isRunning}
                  className="flex-1 px-3 py-2 bg-accent-red hover:bg-accent-red/80 disabled:bg-surface-overlay rounded text-sm text-content flex items-center justify-center gap-2"
                  title="Record interactions from preview"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="8" />
                  </svg>
                  Record
                </button>
              )}
              <button
                onClick={handleCreateNew}
                disabled={isRecording || isRunning}
                className="flex-1 px-3 py-2 bg-accent-blue hover:bg-accent-blue/80 disabled:bg-surface-overlay rounded text-sm text-content flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Test
              </button>
            </div>

            {/* Recording in progress indicator */}
            {isRecording && (
              <div className="mb-4 p-3 bg-accent-red/20 border border-accent-red rounded">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-accent-red font-medium flex items-center gap-2">
                    <span className="w-2 h-2 bg-accent-red rounded-full animate-pulse"></span>
                    Recording in progress...
                  </span>
                  <span className="text-xs text-content-secondary">{recordedSteps.length} action(s)</span>
                </div>
                <p className="text-xs text-content-secondary mb-2">
                  Interact with the preview to record test steps
                </p>
                {recordedSteps.length > 0 && (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {recordedSteps.map((action, index) => (
                      <div key={index} className="text-xs text-content bg-surface rounded px-2 py-1 flex items-center gap-2">
                        <span className="text-content-tertiary">{index + 1}.</span>
                        <span className="capitalize text-accent-blue">{action.action}</span>
                        <span className="truncate flex-1">{getActionDescription(action)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Recorded steps (not recording) - show if there are recorded steps to create from */}
            {!isRecording && recordedSteps.length > 0 && (
              <div className="mb-4 p-3 bg-accent-green/20 border border-accent-green rounded">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-accent-green font-medium">
                    {recordedSteps.length} action(s) recorded
                  </span>
                  <button
                    onClick={onClearRecording}
                    className="text-xs text-content-secondary hover:text-accent-red"
                    title="Clear recorded steps"
                  >
                    Clear
                  </button>
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto mb-2">
                  {recordedSteps.map((action, index) => (
                    <div key={index} className="text-xs text-content bg-surface rounded px-2 py-1 flex items-center gap-2">
                      <span className="text-content-tertiary">{index + 1}.</span>
                      <span className="capitalize text-accent-blue">{action.action}</span>
                      <span className="truncate flex-1">{getActionDescription(action)}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={handleCreateFromRecording}
                  className="w-full px-2 py-1.5 bg-accent-green hover:bg-accent-green/80 rounded text-xs text-content"
                >
                  Create Test from Recording
                </button>
              </div>
            )}

            {isLoading ? (
              <div className="text-center text-content-secondary text-sm py-8">
                <svg className="w-5 h-5 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Loading tests...
              </div>
            ) : loadError ? (
              <div className="text-center text-accent-red text-sm py-4">
                <p className="mb-2">{loadError}</p>
                <button
                  onClick={loadTests}
                  className="text-accent-blue hover:text-accent-blue underline"
                >
                  Retry
                </button>
              </div>
            ) : tests.length === 0 ? (
              <div className="text-center text-content-secondary text-sm py-8">
                No tests yet. Create your first test!
              </div>
            ) : (
              <div className="space-y-2">
                {tests.map(test => (
                  <div
                    key={test.id}
                    className="bg-surface rounded p-3 hover:bg-surface-hover"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-content font-medium">{test.name}</span>
                      <span className="text-xs text-content-tertiary">{test.steps.length} steps</span>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRunTest(test)}
                        disabled={isRunning || isDeleting === test.id}
                        className="flex-1 px-2 py-1 bg-accent-green hover:bg-accent-green/80 disabled:bg-surface-overlay rounded text-xs text-content flex items-center justify-center gap-1"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        </svg>
                        Run
                      </button>
                      <button
                        onClick={() => handleEditTest(test)}
                        disabled={isDeleting === test.id}
                        className="px-2 py-1 bg-surface-elevated hover:bg-surface-hover disabled:bg-surface-overlay rounded text-xs text-content"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteTest(test)}
                        disabled={isDeleting === test.id}
                        className="px-2 py-1 bg-surface-elevated hover:bg-accent-red/80 disabled:bg-surface-overlay rounded text-xs text-content flex items-center gap-1"
                      >
                        {isDeleting === test.id ? (
                          <>
                            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Deleting...
                          </>
                        ) : (
                          'Delete'
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Running Test Results */}
        {isRunning && (
          <div className="p-3 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-content-secondary">Running Test...</span>
              <button
                onClick={onStopTest}
                className="px-2 py-1 bg-accent-red hover:bg-accent-red/80 rounded text-xs text-content"
              >
                Stop
              </button>
            </div>
            <div className="space-y-1">
              {stepResults.map((result, index) => (
                <div key={index} className="flex items-center gap-2 text-xs">
                  {getStepResultIcon(result.stepIndex)}
                  <span className={result.status === 'pass' ? 'text-accent-green' : result.status === 'fail' ? 'text-accent-red' : 'text-content-secondary'}>
                    Step {result.stepIndex + 1}: {result.status}
                  </span>
                  {result.error && (
                    <span className="text-accent-red text-xs truncate" title={result.error}>
                      - {result.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Last Test Result */}
        {!isRunning && lastTestResult && (
          <div className="p-3 border-t border-border">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs font-medium ${lastTestResult.status === 'pass' ? 'text-accent-green' : 'text-accent-red'}`}>
                Last Run: {lastTestResult.status.toUpperCase()}
              </span>
              <span className="text-xs text-content-tertiary">
                ({Math.round(lastTestResult.duration)}ms)
              </span>
            </div>
            <div className="space-y-1">
              {lastTestResult.steps.map((result, index) => (
                <div key={index} className="flex items-center gap-2 text-xs">
                  {result.status === 'pass' ? (
                    <svg className="w-3 h-3 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3 text-accent-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  <span className={result.status === 'pass' ? 'text-accent-green' : 'text-accent-red'}>
                    Step {result.stepIndex + 1}
                  </span>
                  {result.error && (
                    <span className="text-accent-red text-xs truncate flex-1" title={result.error}>
                      - {result.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Visual Diff Modal */}
      {visualDiffModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg shadow-xl max-w-6xl max-h-[90vh] w-full mx-4 flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-4">
                <h3 className="text-lg font-medium text-content">
                  Visual Diff - Step {visualDiffModal.stepIndex + 1}
                </h3>
                {!visualDiffModal.noBaseline && (
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    visualDiffModal.matchPercentage >= 99.9
                      ? 'bg-accent-green text-content'
                      : visualDiffModal.matchPercentage >= 95
                      ? 'bg-accent-yellow text-content'
                      : 'bg-accent-red text-content'
                  }`}>
                    {visualDiffModal.matchPercentage.toFixed(2)}% Match
                  </span>
                )}
                {visualDiffModal.noBaseline && (
                  <span className="px-2 py-1 rounded text-xs font-medium bg-accent-blue text-content">
                    No Baseline
                  </span>
                )}
                {/* Screenshot progress indicator */}
                {(() => {
                  const totalScreenshots = stepResults.filter(r => r.screenshotData?.imageData).length;
                  if (totalScreenshots > 1) {
                    return (
                      <span className="px-2 py-1 rounded text-xs font-medium bg-surface-overlay text-content">
                        Screenshot {processedScreenshots.size} of {totalScreenshots}
                      </span>
                    );
                  }
                  return null;
                })()}
              </div>
              <button
                onClick={() => setVisualDiffModal(null)}
                className="text-content-secondary hover:text-content"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-4">
              {visualDiffModal.noBaseline ? (
                <div className="text-center">
                  <p className="text-content-secondary mb-4">
                    No baseline exists for this screenshot. Set this as the baseline to enable visual comparison.
                  </p>
                  <div className="max-w-md mx-auto">
                    <p className="text-xs text-content-tertiary mb-2">Current Screenshot:</p>
                    <img
                      src={visualDiffModal.currentImage}
                      alt="Current screenshot"
                      className="w-full border border-border-strong rounded"
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  {/* Baseline Image */}
                  <div>
                    <p className="text-xs text-content-secondary mb-2 text-center">Baseline</p>
                    {visualDiffModal.baselineImage ? (
                      <img
                        src={visualDiffModal.baselineImage}
                        alt="Baseline screenshot"
                        className="w-full border border-border-strong rounded"
                      />
                    ) : (
                      <div className="w-full h-48 bg-surface-elevated rounded flex items-center justify-center text-content-tertiary">
                        No baseline
                      </div>
                    )}
                  </div>

                  {/* Current Image */}
                  <div>
                    <p className="text-xs text-content-secondary mb-2 text-center">Current</p>
                    <img
                      src={visualDiffModal.currentImage}
                      alt="Current screenshot"
                      className="w-full border border-border-strong rounded"
                    />
                  </div>

                  {/* Diff Image */}
                  <div>
                    <p className="text-xs text-content-secondary mb-2 text-center">Difference</p>
                    {visualDiffModal.diffImage ? (
                      <img
                        src={visualDiffModal.diffImage}
                        alt="Diff image"
                        className="w-full border border-border-strong rounded"
                      />
                    ) : (
                      <div className="w-full h-48 bg-surface-elevated rounded flex items-center justify-center text-content-tertiary">
                        No differences
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between p-4 border-t border-border">
              <p className="text-xs text-content-secondary">
                {visualDiffModal.noBaseline
                  ? 'Set this screenshot as the baseline to enable future visual comparisons.'
                  : 'Red pixels in the diff image indicate visual differences between baseline and current.'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setVisualDiffModal(null)}
                  className="px-4 py-2 bg-surface-elevated hover:bg-surface-hover rounded text-sm text-content"
                >
                  Close
                </button>
                <button
                  onClick={handleSetBaseline}
                  disabled={settingBaseline !== null}
                  className="px-4 py-2 bg-accent-blue hover:bg-accent-blue/80 disabled:bg-surface-overlay rounded text-sm text-content flex items-center gap-2"
                >
                  {settingBaseline !== null ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Setting...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Set as Baseline
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TestPanel;
