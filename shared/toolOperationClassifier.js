const FILE_PATH_KEYS = new Set([
  'file_path',
  'filepath',
  'path',
  'sourcefile',
  'source_file',
  'target_file',
  'targetfile',
  'targetpath',
  'target_path',
  'destination',
  'destinationfile',
  'destination_file',
  'destinationpath',
  'destination_path',
  'output',
  'outputfile',
  'output_file',
  'outputpath',
  'output_path',
  'from',
  'to',
]);

const FILE_ACTION_KEYS = [
  'action',
  'operation',
  'change_type',
  'changeType',
  'mode',
];

const FILE_MUTATION_ACTIONS = new Set([
  'write',
  'edit',
  'create',
  'delete',
  'rename',
  'move',
  'copy',
]);

const SNAPSHOT_ELIGIBLE_ACTIONS = new Set([
  'write',
  'edit',
  'create',
]);

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readDeclaredFileAction(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  for (const key of FILE_ACTION_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) {
      return normalizeToken(value);
    }
  }
  return '';
}

function matchToolKind(normalizedName) {
  if (!normalizedName) return 'unknown';

  if (
    normalizedName === 'write'
    || normalizedName === 'write_file'
    || normalizedName === 'writefile'
    || normalizedName === 'file_write'
    || normalizedName === 'filewrite'
    || normalizedName === 'create_file'
    || normalizedName === 'createfile'
    || normalizedName === 'save_file'
    || normalizedName === 'savefile'
  ) {
    return 'write';
  }

  if (
    normalizedName === 'edit'
    || normalizedName === 'edit_file'
    || normalizedName === 'editfile'
    || normalizedName === 'file_edit'
    || normalizedName === 'fileedit'
    || normalizedName === 'multiedit'
    || normalizedName === 'multi_edit'
    || normalizedName === 'notebookedit'
    || normalizedName === 'notebook_edit'
    || normalizedName === 'update_file'
    || normalizedName === 'updatefile'
    || normalizedName === 'replace_file'
    || normalizedName === 'replacefile'
    || normalizedName === 'patch_file'
    || normalizedName === 'patchfile'
  ) {
    return 'edit';
  }

  if (
    normalizedName === 'read'
    || normalizedName === 'read_file'
    || normalizedName === 'readfile'
    || normalizedName === 'file_read'
    || normalizedName === 'fileread'
    || normalizedName === 'grep'
    || normalizedName === 'glob'
    || normalizedName === 'search'
    || normalizedName === 'find'
    || normalizedName === 'list_directory'
    || normalizedName === 'listdirectory'
    || normalizedName === 'ls'
  ) {
    return 'read';
  }

  if (
    normalizedName === 'bash'
    || normalizedName === 'run_shell_command'
    || normalizedName === 'runshellcommand'
    || normalizedName === 'shell'
    || normalizedName === 'command'
  ) {
    return 'shell';
  }

  if (
    normalizedName === 'reasoning'
    || normalizedName === 'thinking'
    || normalizedName === 'thought'
  ) {
    return 'reasoning';
  }

  if (
    normalizedName === 'filechange'
    || normalizedName === 'file_change'
  ) {
    return 'file_change';
  }

  return 'unknown';
}

export function normalizeToolName(toolName) {
  return normalizeToken(toolName);
}

export function extractToolPathFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;

  const queue = [toolInput];
  let inspected = 0;

  while (queue.length > 0 && inspected < 50) {
    inspected += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === 'object') {
          queue.push(item);
        }
      }
      continue;
    }

    for (const [rawKey, value] of Object.entries(current)) {
      const key = normalizeToken(rawKey);
      if (FILE_PATH_KEYS.has(key) && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

export function classifyToolOperation(toolName, toolInput = {}) {
  const normalizedName = normalizeToolName(toolName);
  const filePath = extractToolPathFromToolInput(toolInput);
  const declaredAction = readDeclaredFileAction(toolInput);

  let kind = matchToolKind(normalizedName);
  let fileAction = '';

  if (kind === 'file_change') {
    if (declaredAction === 'read') {
      kind = 'read';
      fileAction = 'read';
    } else if (FILE_MUTATION_ACTIONS.has(declaredAction)) {
      kind = declaredAction === 'edit' ? 'edit' : 'write';
      fileAction = declaredAction;
    } else {
      kind = 'unknown';
      fileAction = '';
    }
  } else if (kind === 'write') {
    fileAction = normalizedName.startsWith('create') ? 'create' : 'write';
  } else if (kind === 'edit') {
    fileAction = 'edit';
  } else if (kind === 'read') {
    fileAction = 'read';
  }

  const mutatesFiles = FILE_MUTATION_ACTIONS.has(fileAction);
  const snapshotEligible = SNAPSHOT_ELIGIBLE_ACTIONS.has(fileAction);

  return {
    normalizedName,
    kind,
    fileAction,
    filePath,
    mutatesFiles,
    snapshotEligible,
    isReadOnly: fileAction === 'read' || (!mutatesFiles && kind === 'read'),
  };
}

export function isFileMutationTool(toolName, toolInput = {}) {
  return classifyToolOperation(toolName, toolInput).mutatesFiles;
}

export function isSnapshotEligibleFileMutationTool(toolName, toolInput = {}) {
  return classifyToolOperation(toolName, toolInput).snapshotEligible;
}
