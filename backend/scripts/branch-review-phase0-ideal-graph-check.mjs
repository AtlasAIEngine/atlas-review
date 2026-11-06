#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { parseReviewResponse } from '../src/services/review/reviewPromptBuilder.js';

const RUBRIC_LABELS = Object.freeze({
  CORRECT_DOMINANT: 'correct_dominant',
  CORRECT_ADJACENT: 'correct_adjacent',
  WRONG_DOMINANT: 'wrong_dominant',
  PRAISE_ONLY: 'praise_only_or_suggestion_only',
});

function buildParserDecisionSpec() {
  return {
    phase: 'parser_decision_spec',
    generatedAt: new Date().toISOString(),
    sentinelCriticalQueries: [
      {
        id: 'nextjs_reexport_boundary_path',
        caseId: 'nextjs_92231',
        repo: 'vercel/next.js',
        description: 'Resolve the changed app-render boundary logic through local imports and re-export or ownership edges strongly enough to explain the app-render to create-component-tree boundary path.',
        successCriteria: [
          'Must recover a bounded path from app-render.tsx to create-component-tree.tsx or equivalent ownership surface.',
          'Must distinguish structural boundary traversal from adjacent duplicate-type or cast-only noise.',
          'Must not count heuristic nearby-file guesses as semantic coverage.',
        ],
        acceptableProvenance: ['ast_graph', 'semantic_graph'],
        fallbackProvenance: ['syntax_fallback', 'heuristic_fallback'],
      },
      {
        id: 'dotnet_parser_consumer_path',
        caseId: 'runtime_126352',
        repo: 'dotnet/runtime',
        description: 'Resolve the parser-consumer production path strongly enough to connect helper-side parsing changes to the SslStream consumer guard that becomes the dominant review target.',
        successCriteria: [
          'Must recover a bounded parser-consumer path that includes the production consumer surface.',
          'Must preserve the real SslStream.IO.cs issue as dominant over helper or fuzzer praise.',
          'Must treat syntax-only path guesses as fallback rather than semantic proof.',
        ],
        acceptableProvenance: ['semantic_graph'],
        fallbackProvenance: ['syntax_fallback', 'heuristic_fallback'],
      },
    ],
  };
}

function countAnchored(recommendations = []) {
  return recommendations.filter((recommendation) => {
    const evidence = recommendation?.evidence;
    return Boolean(
      recommendation?.file
      || (typeof recommendation?.line === 'number')
      || evidence?.file
      || (typeof evidence?.line === 'number')
    );
  }).length;
}

function buildContext(input, branchAnalysis = null) {
  const filePaths = Array.isArray(input?.changedFiles) ? input.changedFiles : [];
  // Replay baselines must preserve live branch-judge context, including top-level branchAnalysis.
  const effectiveBranchAnalysis = branchAnalysis || input?.branchAnalysis || input?.dependencyVerificationTargets?.branchAnalysis || null;
  const dependencyVerificationTargets = input?.dependencyVerificationTargets
    && typeof input.dependencyVerificationTargets === 'object'
    ? {
        ...input.dependencyVerificationTargets,
        branchAnalysis: effectiveBranchAnalysis,
      }
    : null;

  return {
    qualityMode: 'v2',
    reviewType: 'branch_review',
    agenticMode: true,
    filePaths,
    fileCount: filePaths.length,
    reviewProfile: {
      id: input?.reviewProfileId || null,
      conclusionShaping: input?.conclusionShaping && typeof input.conclusionShaping === 'object'
        ? input.conclusionShaping
        : null,
    },
    dependencyVerificationTargets,
    branchAnalysis: effectiveBranchAnalysis,
  };
}

function buildNextjsIdealBranchAnalysis() {
  return {
    mode: 'analyzer_judge',
    graphQueries: [
      {
        id: 'nextjs_reexport_boundary_path',
        kind: 'ownership_path',
        provenance: 'ast_graph',
        status: 'answered',
        fromPath: 'packages/next/src/server/app-render/app-render.tsx',
        toPath: 'packages/next/src/server/app-render/create-component-tree.tsx',
        evidence: [
          'bounded graph path crosses local import and re-export edges inside app-render',
          'boundary path corroborates prerender recovery bug class instead of duplicate-type noise',
        ],
      },
    ],
    analyzerFacts: [
      {
        analyzerId: 'nextjs_prerender_recovery',
        bugClass: 'prerender_recovery_boundary',
        fact: 'app-render.tsx reaches create-component-tree.tsx through bounded ownership path',
        provenance: 'ast_graph',
      },
    ],
    analyzerObligations: [
      {
        id: 'nextjs_prerender_recovery_dominant_issue',
        analyzerId: 'nextjs_prerender_recovery',
        bugClass: 'prerender_recovery_boundary',
        targetPaths: [
          'packages/next/src/server/app-render/app-render.tsx',
          'packages/next/src/server/app-render/create-component-tree.tsx',
        ],
        queryIds: ['nextjs_reexport_boundary_path'],
        requirementKind: 'dominant_issue',
        expectedEvidenceKinds: ['ownership_path', 'bug_class_alignment'],
        failurePolicy: 'suppress_adjacent_wrong_issue',
        status: 'satisfied',
        provenance: 'ast_graph',
      },
    ],
    coverageGaps: [],
    graphQueryLines: [
      'Graph query nextjs_reexport_boundary_path: answered via ast_graph, app-render.tsx -> create-component-tree.tsx bounded ownership path recovered.',
    ],
    analyzerObligationLines: [
      'Analyzer obligation nextjs_prerender_recovery_dominant_issue: satisfied, keep dominant issue on the prerender recovery boundary and suppress duplicate-type/cast side issues.',
    ],
    coverageGapLines: [],
    analyzerProvenanceLines: [
      'Phase 0 ideal graph facts: bounded graph exposes the app-render to create-component-tree boundary path and corroborates the prerender recovery bug class.',
    ],
    analyzerLines: [
      'Analyzer nextjs_prerender_recovery: ideal bounded graph facts tie app-render.tsx and create-component-tree.tsx to the same prerender recovery path, prioritize parallel route / children slot / wrong segment boundary, suppress duplicate type / unsafe cast side issues.',
    ],
    judgeProvenanceLines: [
      'Judge provenance: ideal graph facts select the prerender recovery analyzer as dominant for the branch-only output budget.',
    ],
    judgeLines: [
      'Judge mode dominant_verified_findings_with_issue_class_guard, dominant analyzers nextjs_prerender_recovery, issue budget 1, require strong match parallel route / children slot / wrong segment boundary, suppress duplicate type / getaccessfallbackhttpstatus / unsafe cast, suppress praise tee / stream lifecycle.',
    ],
    analyzers: [
      {
        id: 'nextjs_prerender_recovery',
        dominantIssueBudget: 1,
        supportingFiles: [
          'packages/next/src/server/app-render/app-render.tsx',
          'packages/next/src/server/app-render/create-component-tree.tsx',
        ],
        preferredPathPatterns: [
          'packages/next/src/server/app-render/',
        ],
        supportTextPatterns: [
          'parallel route',
          'children slot',
          'wrong segment boundary',
          'throwing subtree',
          'fallback',
        ],
        dominantTextPatterns: [
          'parallel route',
          'children slot',
          'wrong segment boundary',
          'throwing subtree',
        ],
        suppressedIssueTextPatterns: [
          'duplicate httpaccesserrorstatuscode',
          'duplicated httpaccesserrorstatuscode',
          'duplicate type',
          'getaccessfallbackhttpstatus',
          'unsafe cast',
          'type cast',
        ],
        suppressedPraiseTextPatterns: [
          'stream lifecycle',
          'tee',
          'consume',
        ],
      },
    ],
    judge: {
      dominantAnalyzerIds: ['nextjs_prerender_recovery'],
      dominantIssueBudget: 1,
      preferredPathPatterns: [
        'packages/next/src/server/app-render/',
      ],
      dominantTextPatterns: [
        'parallel route',
        'children slot',
        'wrong segment boundary',
        'throwing subtree',
      ],
      supportTextPatterns: [
        'parallel route',
        'children slot',
        'fallback',
      ],
      suppressedIssueTextPatterns: [
        'duplicate httpaccesserrorstatuscode',
        'duplicated httpaccesserrorstatuscode',
        'duplicate type',
        'getaccessfallbackhttpstatus',
        'unsafe cast',
        'type cast',
      ],
      suppressedPraiseTextPatterns: [
        'stream lifecycle',
        'tee',
        'consume',
      ],
      strongMatchTextPatterns: [
        'parallel route',
        'children slot',
        'wrong segment boundary',
        'throwing subtree',
      ],
      wrongIssueTextPatterns: [
        'duplicate httpaccesserrorstatuscode',
        'duplicated httpaccesserrorstatuscode',
        'duplicate type',
        'getaccessfallbackhttpstatus',
        'unsafe cast',
        'type cast',
      ],
      praiseOnlyTextPatterns: [
        'stream lifecycle',
        'tee',
        'consume',
      ],
    },
  };
}

function buildRuntimeIdealBranchAnalysis() {
  return {
    mode: 'analyzer_judge',
    graphQueries: [
      {
        id: 'dotnet_parser_consumer_path',
        kind: 'parser_consumer_path',
        provenance: 'semantic_graph',
        status: 'answered',
        fromPath: 'src/libraries/System.Net.Security/src/System/Net/Security/TlsFrameHelper.cs',
        toPath: 'src/libraries/System.Net.Security/src/System/Net/Security/SslStream.IO.cs',
        evidence: [
          'bounded semantic path connects helper-side parsing changes to the production consumer guard',
          'helper and fuzzer files remain support context; production consumer path is the dominant target',
        ],
      },
    ],
    analyzerFacts: [
      {
        analyzerId: 'dotnet_tls_parser_consumer',
        bugClass: 'parser_consumer_invariant',
        fact: 'TlsFrameHelper.cs reaches SslStream.IO.cs through bounded semantic parser-consumer path',
        provenance: 'semantic_graph',
      },
    ],
    analyzerObligations: [
      {
        id: 'dotnet_tls_parser_consumer_dominant_issue',
        analyzerId: 'dotnet_tls_parser_consumer',
        bugClass: 'parser_consumer_invariant',
        targetPaths: [
          'src/libraries/System.Net.Security/src/System/Net/Security/TlsFrameHelper.cs',
          'src/libraries/System.Net.Security/src/System/Net/Security/SslStream.IO.cs',
        ],
        queryIds: ['dotnet_parser_consumer_path'],
        requirementKind: 'dominant_issue',
        expectedEvidenceKinds: ['parser_consumer_path', 'production_consumer_alignment'],
        failurePolicy: 'suppress_support_file_output',
        status: 'satisfied',
        provenance: 'semantic_graph',
      },
    ],
    coverageGaps: [],
    graphQueryLines: [
      'Graph query dotnet_parser_consumer_path: answered via semantic_graph, TlsFrameHelper.cs -> SslStream.IO.cs bounded parser-consumer path recovered.',
    ],
    analyzerObligationLines: [
      'Analyzer obligation dotnet_tls_parser_consumer_dominant_issue: satisfied, keep the dominant finding on SslStream.IO.cs parser-consumer invariants and suppress helper/fuzzer support-file output.',
    ],
    coverageGapLines: [],
    analyzerProvenanceLines: [
      'Phase 0 ideal graph facts: bounded graph exposes the TlsFrameHelper to SslStream.IO parser-consumer path and marks helper/fuzzer files as support context only.',
    ],
    analyzerLines: [
      'Analyzer dotnet_tls_parser_consumer: ideal bounded graph facts keep the dominant finding on SslStream.IO.cs parser-consumer invariants, suppress helper praise and fuzzer/support-file side output.',
    ],
    judgeProvenanceLines: [
      'Judge provenance: ideal graph facts select the TLS parser-consumer analyzer as dominant for the branch-only output budget.',
    ],
    judgeLines: [
      'Judge mode dominant_verified_findings_with_issue_class_guard, dominant analyzers dotnet_tls_parser_consumer, issue budget 1, require strong match sslstream / clienthello / unchecked offset / zero-payload, suppress helper praise and fuzzer-side commentary.',
    ],
    analyzers: [
      {
        id: 'dotnet_tls_parser_consumer',
        dominantIssueBudget: 1,
        supportingFiles: [
          'src/libraries/System.Net.Security/src/System/Net/Security/SslStream.IO.cs',
          'src/libraries/System.Net.Security/src/System/Net/Security/TlsFrameHelper.cs',
        ],
        preferredPathPatterns: [
          'src/libraries/system.net.security/src/system/net/security/',
        ],
        supportTextPatterns: [
          'sslstream',
          'parser-consumer invariant',
          'clienthello',
          'unchecked offset',
          'unchecked length',
          'zero-payload',
          'handshake frame',
        ],
        dominantTextPatterns: [
          'sslstream',
          'clienthello',
          'unchecked offset',
          'zero-payload',
          'handshake frame',
        ],
        suppressedIssueTextPatterns: [
          'sr.fake',
          'support file',
          'newline',
          'fuzzer',
        ],
        suppressedPraiseTextPatterns: [
          'tlsframehelper',
          'bounds-check hardening',
          'well-designed fuzzer',
          'resource management',
          'fuzzer',
        ],
      },
    ],
    judge: {
      dominantAnalyzerIds: ['dotnet_tls_parser_consumer'],
      dominantIssueBudget: 1,
      preferredPathPatterns: [
        'src/libraries/system.net.security/src/system/net/security/',
      ],
      dominantTextPatterns: [
        'sslstream',
        'clienthello',
        'unchecked offset',
        'zero-payload',
      ],
      supportTextPatterns: [
        'parser-consumer invariant',
        'handshake frame',
        'unchecked length',
      ],
      suppressedIssueTextPatterns: [
        'sr.fake',
        'support file',
        'newline',
        'fuzzer',
      ],
      suppressedPraiseTextPatterns: [
        'tlsframehelper',
        'bounds-check hardening',
        'well-designed fuzzer',
        'resource management',
        'fuzzer',
      ],
      strongMatchTextPatterns: [
        'sslstream',
        'clienthello',
        'unchecked offset',
        'zero-payload',
      ],
      wrongIssueTextPatterns: [
        'sr.fake',
        'support file',
        'newline',
        'fuzzer',
      ],
      praiseOnlyTextPatterns: [
        'tlsframehelper',
        'bounds-check hardening',
        'well-designed fuzzer',
        'resource management',
        'fuzzer',
      ],
    },
  };
}

function summarizeRecommendations(parsed) {
  const recommendations = Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
  return {
    recommendationCount: recommendations.length,
    issueCount: recommendations.filter((entry) => entry?.type === 'issue').length,
    anchoredCount: countAnchored(recommendations),
    recommendations: recommendations.map((entry) => ({
      type: entry?.type || null,
      severity: entry?.severity || null,
      title: entry?.title || null,
      file: entry?.file || entry?.evidence?.file || null,
      line: Number.isFinite(entry?.line) ? entry.line : (Number.isFinite(entry?.evidence?.line) ? entry.evidence.line : null),
    })),
  };
}

function evaluateNextjs(summary) {
  const recommendations = Array.isArray(summary?.recommendations) ? summary.recommendations : [];
  const issueTitles = recommendations.filter((entry) => entry.type === 'issue').map((entry) => String(entry.title || '').toLowerCase());
  const topIssue = issueTitles[0] || '';
  return {
    topIssue,
    hasExpectedIssue: issueTitles.some((title) => title.includes('children slot') || title.includes('parallel route')),
    hasWrongDominant: topIssue.includes('duplicate') || topIssue.includes('cast') || topIssue.includes('httpaccesserrorstatuscode'),
    praiseCount: recommendations.filter((entry) => entry.type === 'praise').length,
  };
}

function scoreNextjsRubric(summary) {
  const evaluation = evaluateNextjs(summary);
  if (!evaluation.topIssue) return RUBRIC_LABELS.PRAISE_ONLY;
  if (evaluation.hasExpectedIssue && !evaluation.hasWrongDominant) return RUBRIC_LABELS.CORRECT_DOMINANT;
  if (evaluation.hasWrongDominant) return RUBRIC_LABELS.WRONG_DOMINANT;
  return RUBRIC_LABELS.CORRECT_ADJACENT;
}

function evaluateRuntime(summary) {
  const recommendations = Array.isArray(summary?.recommendations) ? summary.recommendations : [];
  const issueFiles = recommendations
    .filter((entry) => entry.type === 'issue')
    .map((entry) => String(entry.file || '').toLowerCase());
  const praiseTitles = recommendations
    .filter((entry) => entry.type === 'praise')
    .map((entry) => String(entry.title || '').toLowerCase());
  return {
    hasSslStreamIssue: issueFiles.some((file) => file.includes('sslstream.io.cs')),
    hasPraiseLeakage: praiseTitles.some((title) => title.includes('tlsframehelper') || title.includes('bounds-check hardening') || title.includes('fuzzer')),
    topIssue: recommendations.find((entry) => entry.type === 'issue')?.title || null,
  };
}

function scoreRuntimeRubric(summary) {
  const evaluation = evaluateRuntime(summary);
  if (!evaluation.topIssue) return RUBRIC_LABELS.PRAISE_ONLY;
  if (evaluation.hasSslStreamIssue && !evaluation.hasPraiseLeakage) return RUBRIC_LABELS.CORRECT_DOMINANT;
  if (evaluation.hasSslStreamIssue) return RUBRIC_LABELS.CORRECT_ADJACENT;
  return RUBRIC_LABELS.WRONG_DOMINANT;
}

function scoreRubric(caseId, summary) {
  if (caseId === 'nextjs_92231') return scoreNextjsRubric(summary);
  if (caseId === 'runtime_126352') return scoreRuntimeRubric(summary);
  return RUBRIC_LABELS.CORRECT_ADJACENT;
}

function compareRubricLabels(left, right) {
  const ranking = {
    [RUBRIC_LABELS.CORRECT_DOMINANT]: 3,
    [RUBRIC_LABELS.CORRECT_ADJACENT]: 2,
    [RUBRIC_LABELS.WRONG_DOMINANT]: 1,
    [RUBRIC_LABELS.PRAISE_ONLY]: 0,
  };
  return (ranking[left] ?? -1) - (ranking[right] ?? -1);
}

function buildBlindedCandidates(caseId, baselineSummary, injectedSummary) {
  const ordered = caseId === 'nextjs_92231'
    ? [
        { variant: 'injected', summary: injectedSummary },
        { variant: 'baseline', summary: baselineSummary },
      ]
    : [
        { variant: 'baseline', summary: baselineSummary },
        { variant: 'injected', summary: injectedSummary },
      ];
  return ordered.map((entry, index) => ({
    blindId: `candidate_${index + 1}`,
    recommendationCount: entry.summary.recommendationCount,
    issueCount: entry.summary.issueCount,
    anchoredCount: entry.summary.anchoredCount,
    recommendations: entry.summary.recommendations,
    rubricLabel: scoreRubric(caseId, entry.summary),
  }));
}

function buildIndependentRescore(caseId, baselineSummary, injectedSummary) {
  const baselineLabel = scoreRubric(caseId, baselineSummary);
  const injectedLabel = scoreRubric(caseId, injectedSummary);
  const comparison = compareRubricLabels(injectedLabel, baselineLabel);
  return {
    method: 'blinded_rubric_rescore',
    baselineLabel,
    injectedLabel,
    outcome: comparison > 0 ? 'confirmed_improvement' : comparison === 0 ? 'confirmed_hold' : 'confirmed_regression',
    blindedCandidates: buildBlindedCandidates(caseId, baselineSummary, injectedSummary),
  };
}

function classifyCase(caseId, baselineSummary, injectedSummary) {
  if (caseId === 'nextjs_92231') {
    const baseline = evaluateNextjs(baselineSummary);
    const injected = evaluateNextjs(injectedSummary);
    if (!baseline.hasExpectedIssue && injected.hasExpectedIssue && !injected.hasWrongDominant) {
      return 'improved';
    }
    if (baseline.hasExpectedIssue && injected.hasExpectedIssue && injected.praiseCount <= baseline.praiseCount) {
      return 'held';
    }
    if (injected.hasWrongDominant) {
      return 'regressed';
    }
    return 'inconclusive';
  }

  if (caseId === 'runtime_126352') {
    const baseline = evaluateRuntime(baselineSummary);
    const injected = evaluateRuntime(injectedSummary);
    if (!baseline.hasSslStreamIssue && injected.hasSslStreamIssue && !injected.hasPraiseLeakage) {
      return 'improved';
    }
    if (baseline.hasSslStreamIssue && injected.hasSslStreamIssue && baseline.hasPraiseLeakage && !injected.hasPraiseLeakage) {
      return 'improved';
    }
    if (baseline.hasSslStreamIssue && injected.hasSslStreamIssue && injected.hasPraiseLeakage === baseline.hasPraiseLeakage) {
      return 'held';
    }
    if (!injected.hasSslStreamIssue) {
      return 'regressed';
    }
    return 'inconclusive';
  }

  return 'inconclusive';
}

function diagnoseNextLayer(caseId, baselineSummary, injectedSummary) {
  if (caseId === 'runtime_126352') {
    const baseline = evaluateRuntime(baselineSummary);
    const injected = evaluateRuntime(injectedSummary);
    if (!baseline.hasSslStreamIssue && injected.hasSslStreamIssue) {
      return 'graph_signal_limited';
    }
    if (!baseline.hasSslStreamIssue && !injected.hasSslStreamIssue) {
      return 'analyzer_judge_or_output_shaping_limited';
    }
    if (baseline.hasSslStreamIssue && injected.hasSslStreamIssue && baseline.hasPraiseLeakage && !injected.hasPraiseLeakage) {
      return 'judge_or_output_shaping_limited';
    }
    return 'mixed_or_inconclusive';
  }

  if (caseId === 'nextjs_92231') {
    const baseline = evaluateNextjs(baselineSummary);
    const injected = evaluateNextjs(injectedSummary);
    if (!baseline.hasExpectedIssue && injected.hasExpectedIssue && !injected.hasWrongDominant) {
      return 'graph_signal_limited';
    }
    if (!baseline.hasExpectedIssue && !injected.hasExpectedIssue) {
      return 'analyzer_judge_or_output_shaping_limited';
    }
    return 'mixed_or_inconclusive';
  }

  return 'mixed_or_inconclusive';
}

async function loadReplayCase({ id, artifactDir, branchAnalysis }) {
  const inputPath = path.join(artifactDir, 'input.json');
  const rawOutputPath = path.join(artifactDir, 'raw-output.txt');
  const [inputText, rawOutputText] = await Promise.all([
    fs.readFile(inputPath, 'utf8'),
    fs.readFile(rawOutputPath, 'utf8'),
  ]);
  const input = JSON.parse(inputText);
  const baselineParsed = parseReviewResponse(rawOutputText, buildContext(input, null));
  const injectedParsed = parseReviewResponse(rawOutputText, buildContext(input, branchAnalysis));
  const baselineSummary = summarizeRecommendations(baselineParsed);
  const injectedSummary = summarizeRecommendations(injectedParsed);
  return {
    id,
    artifactDir,
    baseline: baselineSummary,
    injected: injectedSummary,
    independentRescore: buildIndependentRescore(id, baselineSummary, injectedSummary),
    status: classifyCase(id, baselineSummary, injectedSummary),
    nextLayerDiagnosis: diagnoseNextLayer(id, baselineSummary, injectedSummary),
  };
}

function parseArgs(argv = []) {
  const args = {
    printParserDecisionSpec: false,
    caseId: null,
    artifactDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--print-parser-decision-spec') {
      args.printParserDecisionSpec = true;
      continue;
    }
    if (token === '--case-id') {
      args.caseId = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === '--artifact-dir') {
      args.artifactDir = argv[index + 1] || null;
      index += 1;
    }
  }

  return args;
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write([
      'Usage: node backend/scripts/branch-review-phase0-ideal-graph-check.mjs [options]',
      '',
      'Options:',
      '  --help                        Show this help text.',
      '  --print-parser-decision-spec  Print the sentinel parser decision specification JSON.',
      '  --case-id <id>                Run a single replay case (nextjs_92231 or runtime_126352).',
      '  --artifact-dir <path>         Override the artifact directory for the selected case.',
    ].join('\n'));
    process.stdout.write('\n');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.printParserDecisionSpec) {
    process.stdout.write(`${JSON.stringify(buildParserDecisionSpec(), null, 2)}\n`);
    return;
  }
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const defaultCases = {
    nextjs_92231: {
      id: 'nextjs_92231',
      artifactDir: path.join(projectRoot, 'backend/.artifacts/branch-review-agentic-benchmark/v0.53.27-nextjs-92231-claude-cli'),
      branchAnalysis: buildNextjsIdealBranchAnalysis(),
    },
    runtime_126352: {
      id: 'runtime_126352',
      artifactDir: path.join(projectRoot, 'backend/.artifacts/branch-review-agentic-benchmark/v0.53.29-runtime-126352-claude-cli'),
      branchAnalysis: buildRuntimeIdealBranchAnalysis(),
    },
  };

  const requestedCases = args.caseId
    ? [args.caseId]
    : Object.keys(defaultCases);

  const cases = await Promise.all(requestedCases.map((caseId) => {
    const config = defaultCases[caseId];
    if (!config) {
      throw new Error(`Unsupported case id: ${caseId}`);
    }
    return loadReplayCase({
      ...config,
      artifactDir: args.artifactDir ? path.resolve(args.artifactDir) : config.artifactDir,
    });
  }));

  const overallDecision = (
    cases.some((entry) => entry.status === 'regressed')
      ? 'kill'
      : (cases.some((entry) => entry.status === 'improved')
        ? 'proceed'
        : 'inconclusive')
  );

  const result = {
    phase: 'phase0_ideal_graph_precheck',
    generatedAt: new Date().toISOString(),
    overallDecision,
    independentRescore: {
      method: 'blinded_rubric_rescore',
      baselineLabels: Object.fromEntries(cases.map((entry) => [entry.id, entry.independentRescore.baselineLabel])),
      injectedLabels: Object.fromEntries(cases.map((entry) => [entry.id, entry.independentRescore.injectedLabel])),
      confirmed: cases.every((entry) => entry.independentRescore.outcome !== 'confirmed_regression')
        && cases.some((entry) => entry.independentRescore.outcome === 'confirmed_improvement'),
    },
    cases,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
