import type { ReviewChangeGroup, ReviewRecommendation, RiskLevel } from '@/types';

export type WalkthroughFileRole = 'contract' | 'implementation' | 'consumer' | 'test' | 'docs' | 'generated';

export interface WalkthroughChangeMapNode {
  stepIndex: number;
  label: string;
  primaryRole: WalkthroughFileRole;
  roleCounts: Record<WalkthroughFileRole, number>;
  fileCount: number;
  additions: number;
  deletions: number;
  risk: RiskLevel | null;
  findingCount: number;
}

export interface WalkthroughChangeMapEdge {
  from: number;
  to: number;
  kind: 'implements' | 'consumes' | 'uses' | 'documents' | 'validates' | 'related';
  reason: string;
}

export interface WalkthroughGroupedFile<TFile = ReviewChangeGroup['files'][number]> {
  role: WalkthroughFileRole;
  label: string;
  files: TFile[];
  collapsedByDefault: boolean;
}

export interface WalkthroughChangeMap {
  nodes: WalkthroughChangeMapNode[];
  edges: WalkthroughChangeMapEdge[];
  readOrder: number[];
}

const ROLE_LABELS: Record<WalkthroughFileRole, string> = {
  contract: 'Contracts',
  implementation: 'Implementations',
  consumer: 'Consumers',
  test: 'Tests',
  docs: 'Docs',
  generated: 'Generated / metadata',
};

const ROLE_ORDER: WalkthroughFileRole[] = ['contract', 'implementation', 'consumer', 'test', 'docs', 'generated'];

const ROLE_PRIORITY: Record<WalkthroughFileRole, number> = {
  contract: 0,
  implementation: 1,
  consumer: 2,
  test: 3,
  docs: 4,
  generated: 5,
};

function normalizePath(path: string): string {
  return String(path || '').replace(/\\/g, '/').trim();
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

function tokenize(value: string): Set<string> {
  const source = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const tokens = source.match(/[a-z0-9]{3,}/g) || [];
  return new Set(tokens.filter((token) => !STOP_WORDS.has(token)));
}

const STOP_WORDS = new Set([
  'assets', 'src', 'scripts', 'test', 'tests', 'spec', 'impl', 'implementation',
  'service', 'services', 'component', 'components', 'provider', 'providers',
  'manager', 'utils', 'index', 'readme', 'docs',
]);

export function classifyWalkthroughFileRole(pathValue: string, descriptionValue = ''): WalkthroughFileRole {
  const path = normalizePath(pathValue);
  const lower = path.toLowerCase();
  const file = basename(lower);
  const description = String(descriptionValue || '').toLowerCase();

  if (
    lower.endsWith('.meta')
    || lower.endsWith('.lock')
    || lower === 'package-lock.json'
    || lower.endsWith('/package-lock.json')
    || lower === 'pnpm-lock.yaml'
    || lower.endsWith('/pnpm-lock.yaml')
    || lower === 'yarn.lock'
    || lower.endsWith('/yarn.lock')
    || lower.includes('/generated/')
    || lower.includes('/dist/')
    || lower.includes('/build/')
    || lower.includes('/.next/')
    || lower.includes('/target/')
    || file.endsWith('.min.js')
  ) {
    return 'generated';
  }

  if (
    lower.endsWith('.md')
    || lower.includes('/docs/')
    || file === 'readme'
    || file.startsWith('readme.')
    || file.startsWith('changelog')
  ) {
    return 'docs';
  }

  if (
    lower.includes('/__tests__/')
    || lower.includes('/test/')
    || lower.includes('/tests/')
    || lower.includes('.test.')
    || lower.includes('.spec.')
    || file.endsWith('test.cs')
    || file.endsWith('tests.cs')
    || file.endsWith('spec.cs')
  ) {
    return 'test';
  }

  if (
    lower.endsWith('.d.ts')
    || lower.includes('/types/')
    || lower.includes('/schema')
    || lower.includes('/dto')
    || lower.includes('/contract')
    || lower.includes('/interface')
    || /^I[A-Z][A-Za-z0-9]+/.test(stem(path))
    || description.includes('interface')
    || description.includes('contract')
    || description.includes('api')
  ) {
    return 'contract';
  }

  if (
    lower.includes('/integration')
    || lower.includes('/provider')
    || lower.includes('/consumer')
    || lower.includes('/route')
    || lower.includes('/controller')
    || lower.includes('/page.')
    || lower.includes('/view')
    || lower.includes('/hooks/')
    || file.startsWith('use')
    || description.includes('integrat')
    || description.includes('wire')
    || description.includes('consume')
    || description.includes('provider')
  ) {
    return 'consumer';
  }

  return 'implementation';
}

export function getWalkthroughFileRoleLabel(role: WalkthroughFileRole): string {
  return ROLE_LABELS[role];
}

export function groupWalkthroughFilesByRole<TFile extends { path: string; description?: string }>(
  files: readonly TFile[] | undefined,
): WalkthroughGroupedFile<TFile>[] {
  const grouped = new Map<WalkthroughFileRole, TFile[]>();
  for (const file of files || []) {
    const path = typeof file?.path === 'string' ? file.path : '';
    if (!path) continue;
    const role = classifyWalkthroughFileRole(path, file.description);
    const existing = grouped.get(role) || [];
    existing.push(file);
    grouped.set(role, existing);
  }

  return ROLE_ORDER
    .map((role) => ({
      role,
      label: ROLE_LABELS[role],
      files: grouped.get(role) || [],
      collapsedByDefault: role === 'generated',
    }))
    .filter((group) => group.files.length > 0);
}

function rankRisk(risk: RiskLevel | null | undefined): number {
  if (risk === 'critical') return 4;
  if (risk === 'high') return 3;
  if (risk === 'medium') return 2;
  if (risk === 'low') return 1;
  return 0;
}

function riskFromValue(value: unknown): RiskLevel | null {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') return value;
  return null;
}

function primaryRoleForCounts(counts: Record<WalkthroughFileRole, number>): WalkthroughFileRole {
  let best: WalkthroughFileRole = 'implementation';
  let bestCount = -1;
  const nonGeneratedCount = ROLE_ORDER
    .filter((role) => role !== 'generated')
    .reduce((sum, role) => sum + (counts[role] || 0), 0);
  const eligibleRoles = nonGeneratedCount > 0
    ? ROLE_ORDER.filter((role) => role !== 'generated')
    : ROLE_ORDER;
  for (const role of eligibleRoles) {
    const count = counts[role] || 0;
    if (count > bestCount || (count === bestCount && ROLE_PRIORITY[role] < ROLE_PRIORITY[best])) {
      best = role;
      bestCount = count;
    }
  }
  return best;
}

function stepTokens(group: ReviewChangeGroup): Set<string> {
  const all = new Set<string>();
  for (const token of tokenize(`${group.label || ''} ${group.description || ''}`)) all.add(token);
  for (const file of group.files || []) {
    for (const token of tokenize(`${file.path || ''} ${file.description || ''}`)) all.add(token);
  }
  return all;
}

function hasTokenOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

function stepArea(group: ReviewChangeGroup): string {
  const first = group.files?.find((file) => file?.path)?.path || '';
  const parts = normalizePath(first).split('/').filter(Boolean);
  return parts.length <= 1 ? '' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

function sameArea(a: ReviewChangeGroup, b: ReviewChangeGroup): boolean {
  const areaA = stepArea(a);
  const areaB = stepArea(b);
  return Boolean(areaA && areaB && areaA === areaB);
}

function hasRole(node: WalkthroughChangeMapNode, role: WalkthroughFileRole): boolean {
  return (node.roleCounts[role] || 0) > 0;
}

function isCodeNode(node: WalkthroughChangeMapNode): boolean {
  return node.primaryRole !== 'docs' && node.primaryRole !== 'generated' && node.primaryRole !== 'test';
}

function isRelatedStep(
  groups: readonly ReviewChangeGroup[],
  tokens: readonly Set<string>[],
  from: number,
  to: number,
): boolean {
  return sameArea(groups[from], groups[to]) || hasTokenOverlap(tokens[from], tokens[to]);
}

function isGlueLike(node: WalkthroughChangeMapNode): boolean {
  return /\b(glue|login|lifecycle|wiring|integration|integrat|bootstrap|startup|app)\b/i.test(node.label);
}

function isSupportLike(node: WalkthroughChangeMapNode): boolean {
  return /\b(retry|utility|util|helper|support|fallback|cache)\b/i.test(node.label);
}

function deferredWalkthroughGroupRank(node: WalkthroughChangeMapNode): number | null {
  const label = String(node.label || '').toLowerCase();
  if (label.startsWith('assets and generated files')) return 0;
  if (label.startsWith('deleted files')) return 1;
  return null;
}

function reviewLayerRank(node: WalkthroughChangeMapNode): number {
  const deferredRank = deferredWalkthroughGroupRank(node);
  if (deferredRank !== null) return 1000 + deferredRank;
  if (node.primaryRole === 'docs') return 90;
  if (node.primaryRole === 'generated') return 85;
  if (node.primaryRole === 'test') return 80;
  if (isSupportLike(node)) return 40;
  if (isGlueLike(node) || node.primaryRole === 'consumer') return 30;
  if (node.primaryRole === 'implementation') return 20;
  if (node.primaryRole === 'contract') return 10;
  return 50;
}

function buildNodes(
  groups: readonly ReviewChangeGroup[],
  findings: readonly ReviewRecommendation[],
): WalkthroughChangeMapNode[] {
  return groups.map((group, stepIndex) => {
    const roleCounts: Record<WalkthroughFileRole, number> = {
      contract: 0,
      implementation: 0,
      consumer: 0,
      test: 0,
      docs: 0,
      generated: 0,
    };
    let additions = 0;
    let deletions = 0;
    const paths = new Set<string>();

    for (const file of group.files || []) {
      const role = classifyWalkthroughFileRole(file.path, file.description);
      roleCounts[role] += 1;
      additions += Number(file.additions) || 0;
      deletions += Number(file.deletions) || 0;
      if (file.path) paths.add(file.path);
    }

    const findingCount = findings.filter((finding) => (
      typeof finding.file === 'string' && paths.has(finding.file)
    )).length;

    return {
      stepIndex,
      label: group.label || `Step ${stepIndex + 1}`,
      primaryRole: primaryRoleForCounts(roleCounts),
      roleCounts,
      fileCount: (group.files || []).length,
      additions,
      deletions,
      risk: riskFromValue(group.risk),
      findingCount,
    };
  });
}

function edgeKey(edge: Pick<WalkthroughChangeMapEdge, 'from' | 'to' | 'kind'>): string {
  return `${edge.from}:${edge.to}:${edge.kind}`;
}

function pushEdge(
  edges: WalkthroughChangeMapEdge[],
  seen: Set<string>,
  edge: WalkthroughChangeMapEdge,
): void {
  if (edge.from === edge.to) return;
  const key = edgeKey(edge);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(edge);
}

function buildEdges(groups: readonly ReviewChangeGroup[], nodes: readonly WalkthroughChangeMapNode[]): WalkthroughChangeMapEdge[] {
  const tokens = groups.map(stepTokens);
  const edges: WalkthroughChangeMapEdge[] = [];
  const seen = new Set<string>();
  const contractNodes = nodes.filter((node) => hasRole(node, 'contract') && isCodeNode(node));

  for (const node of nodes) {
    if (hasRole(node, 'contract') && isCodeNode(node)) {
      const soleContractFoundation = contractNodes.length === 1;
      for (const target of nodes) {
        if (target.stepIndex === node.stepIndex || !isCodeNode(target)) continue;
        if (!hasRole(target, 'implementation') && !hasRole(target, 'consumer')) continue;
        if (!soleContractFoundation && !isRelatedStep(groups, tokens, node.stepIndex, target.stepIndex)) continue;

        const targetIsConsumer = hasRole(target, 'consumer');
        const targetIsImplementation = hasRole(target, 'implementation');
        const kind: WalkthroughChangeMapEdge['kind'] = targetIsConsumer && !targetIsImplementation
          ? 'uses'
          : 'implements';
        pushEdge(edges, seen, {
          from: node.stepIndex,
          to: target.stepIndex,
          kind,
          reason: kind === 'implements'
            ? `Step ${target.stepIndex + 1} implements contracts introduced in Step ${node.stepIndex + 1}`
            : `Step ${target.stepIndex + 1} consumes contracts introduced in Step ${node.stepIndex + 1}`,
        });
      }
    }

    if (node.primaryRole === 'implementation' && node.fileCount <= 2) {
      for (const target of nodes) {
        if (target.stepIndex === node.stepIndex || !isCodeNode(target)) continue;
        if (!hasRole(target, 'consumer') && target.primaryRole !== 'implementation') continue;
        if (!hasTokenOverlap(tokens[node.stepIndex], tokens[target.stepIndex])) continue;
        pushEdge(edges, seen, {
          from: node.stepIndex,
          to: target.stepIndex,
          kind: 'uses',
          reason: `Step ${target.stepIndex + 1} uses support code from Step ${node.stepIndex + 1}`,
        });
      }
    }

    if (node.primaryRole === 'test') {
      const target = nodes.find((candidate) => (
        candidate.primaryRole !== 'test'
        && candidate.primaryRole !== 'docs'
        && candidate.primaryRole !== 'generated'
        && (sameArea(groups[node.stepIndex], groups[candidate.stepIndex])
          || hasTokenOverlap(tokens[node.stepIndex], tokens[candidate.stepIndex]))
      ));
      if (target) {
        pushEdge(edges, seen, {
          from: target.stepIndex,
          to: node.stepIndex,
          kind: 'validates',
          reason: `Step ${node.stepIndex + 1} validates related production changes in Step ${target.stepIndex + 1}`,
        });
      }
    }
  }

  for (const node of nodes) {
    if (node.primaryRole !== 'docs') continue;
    for (const target of nodes) {
      if (target.primaryRole === 'docs' || target.primaryRole === 'generated') continue;
      if (node.stepIndex === target.stepIndex) continue;
      // Gate documents edges with the same relatedness check used for other
      // edge kinds, so a docs step doesn't appear to "document" every
      // unrelated feature step in the same diff.
      if (
        !sameArea(groups[node.stepIndex], groups[target.stepIndex])
        && !hasTokenOverlap(tokens[node.stepIndex], tokens[target.stepIndex])
      ) {
        continue;
      }
      pushEdge(edges, seen, {
        from: node.stepIndex,
        to: target.stepIndex,
        kind: 'documents',
        reason: `Step ${node.stepIndex + 1} documents Step ${target.stepIndex + 1}`,
      });
    }
  }

  if (!edges.some((edge) => edge.kind !== 'documents')) {
    for (const node of nodes) {
      if (node.primaryRole === 'docs' || node.primaryRole === 'generated') continue;
      if (node.primaryRole === 'consumer') {
        const candidates = nodes.filter((candidate) => (
          candidate.stepIndex !== node.stepIndex
          && (candidate.primaryRole === 'contract' || candidate.primaryRole === 'implementation')
        ));
        const related = candidates.find((candidate) => (
          sameArea(groups[node.stepIndex], groups[candidate.stepIndex])
          || hasTokenOverlap(tokens[node.stepIndex], tokens[candidate.stepIndex])
        )) || candidates[0];
        if (related) {
          pushEdge(edges, seen, {
            from: related.stepIndex,
            to: node.stepIndex,
            kind: 'uses',
            reason: `Step ${node.stepIndex + 1} consumes changes introduced in Step ${related.stepIndex + 1}`,
          });
        }
      }
    }
  }

  return edges;
}

function compareWithinLayer(a: WalkthroughChangeMapNode, b: WalkthroughChangeMapNode): number {
  const severity = rankRisk(b.risk) - rankRisk(a.risk);
  if (severity !== 0) return severity;
  // Tiebreaks must be stable across the session. `findingCount` is excluded
  // intentionally: it shrinks when the user resolves a finding, which would
  // re-order steps within a layer. Read state is persisted by stepIndex
  // (see walkthroughReadState.ts), so any reorder mid-session would attach
  // existing read marks to the wrong groups.
  const fileCount = b.fileCount - a.fileCount;
  if (fileCount !== 0) return fileCount;
  const label = a.label.localeCompare(b.label);
  if (label !== 0) return label;
  return a.stepIndex - b.stepIndex;
}

function buildLayerTopoOrder(
  layerNodes: readonly WalkthroughChangeMapNode[],
  edges: readonly WalkthroughChangeMapEdge[],
): number[] {
  const nodeIds = new Set(layerNodes.map((node) => node.stepIndex));
  const graph = new Map<number, number[]>();
  const indegree = new Map<number, number>();
  const nodeById = new Map(layerNodes.map((node) => [node.stepIndex, node] as const));
  for (const node of layerNodes) {
    graph.set(node.stepIndex, []);
    indegree.set(node.stepIndex, 0);
  }
  for (const edge of edges) {
    if (edge.kind === 'documents') continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    graph.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  }

  const queue = layerNodes
    .filter((node) => (indegree.get(node.stepIndex) || 0) === 0)
    .sort(compareWithinLayer)
    .map((node) => node.stepIndex);
  const result: number[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    for (const next of graph.get(current) || []) {
      const nextDegree = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
        queue.sort((a, b) => compareWithinLayer(nodeById.get(a)!, nodeById.get(b)!));
      }
    }
  }

  for (const node of layerNodes) {
    if (!result.includes(node.stepIndex)) result.push(node.stepIndex);
  }
  return result;
}

function buildReadOrder(nodes: readonly WalkthroughChangeMapNode[], edges: readonly WalkthroughChangeMapEdge[]): number[] {
  const layers = new Map<number, WalkthroughChangeMapNode[]>();
  for (const node of nodes) {
    const rank = reviewLayerRank(node);
    const existing = layers.get(rank) || [];
    existing.push(node);
    layers.set(rank, existing);
  }

  return Array.from(layers.entries())
    .sort(([rankA], [rankB]) => rankA - rankB)
    .flatMap(([, layerNodes]) => buildLayerTopoOrder(layerNodes, edges));
}

export function buildWalkthroughChangeMap(
  groups: readonly ReviewChangeGroup[],
  findings: readonly ReviewRecommendation[] = [],
): WalkthroughChangeMap {
  const nodes = buildNodes(groups, findings);
  const edges = buildEdges(groups, nodes);
  const readOrder = buildReadOrder(nodes, edges);
  return { nodes, edges, readOrder };
}

export function buildWalkthroughReviewFocus(
  group: ReviewChangeGroup | null | undefined,
  findings: readonly ReviewRecommendation[] = [],
): string[] {
  if (!group) return [];
  const bullets: string[] = [];
  const files = group.files || [];
  const grouped = groupWalkthroughFilesByRole(files);
  const roles = new Set(grouped.map((entry) => entry.role));
  const text = `${group.label || ''} ${group.description || ''} ${files.map((file) => `${file.path || ''} ${file.description || ''}`).join(' ')}`.toLowerCase();

  if (findings.length > 0) {
    bullets.push(`${findings.length} open finding${findings.length === 1 ? '' : 's'} in this step`);
  }
  if (roles.has('contract')) {
    bullets.push('Public contract or API shape changed');
  }
  if (/\basync\b|\bthread\b|\bcancel|\bretry|\btimeout|\bnetwork|\bhttp|\bsocket|\bprovider\b|\bidentity\b|\bauth\b|\bpermission\b/.test(text)) {
    bullets.push('Check lifecycle, identity, cancellation, and external-call behavior');
  }
  if (/\bdb\b|\bdatabase\b|\bsql\b|\bmigration\b|\bpersist|\bstorage|\bcache\b|\bstate (migration|migrate|reset|hydration|hydrate)\b/.test(text)) {
    bullets.push('Check persistence, cache, or state migration behavior');
  }
  if ((roles.has('implementation') || roles.has('consumer') || roles.has('contract')) && !roles.has('test')) {
    bullets.push('No test files are grouped with this change');
  }
  if (roles.size === 1 && roles.has('generated')) {
    bullets.push('Generated or metadata-only changes; verify they match the source asset changes');
  }
  if (roles.has('docs') && roles.size > 1) {
    bullets.push('Docs changed with code; verify examples match the implemented behavior');
  }

  return Array.from(new Set(bullets)).slice(0, 4);
}
