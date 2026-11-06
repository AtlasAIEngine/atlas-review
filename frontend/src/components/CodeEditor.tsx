/**
 * Code Editor Component
 * Monaco Editor wrapper for code editing
 *
 * Uses locally bundled Monaco (not CDN) for Tauri desktop compatibility.
 * The CSP in Tauri production builds blocks CDN script loading,
 * so we configure @monaco-editor/react to use the local monaco-editor package.
 */

import { useRef, useEffect, useCallback } from 'react';
import Editor, { OnMount, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useThemeStore } from '../stores/themeStore';

// Configure web workers for Vite bundling (required for local Monaco)
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// Use locally installed monaco-editor instead of loading from CDN
loader.config({ monaco });

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  readOnly?: boolean;
}

function CodeEditor({ value, onChange, language = 'typescript', readOnly = false }: CodeEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorMountedRef = useRef(false);
  const resolved = useThemeStore((s) => s.resolved);
  // Sync external value into Monaco without stealing focus.
  // We don't pass `value` to <Editor> because its default sync can steal
  // focus from sibling inputs (e.g. number inputs sharing the same state).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model || value === model.getValue()) return;

    if (editor.hasTextFocus()) {
      // Editor owns focus — use executeEdits to preserve undo stack
      const range = model.getFullModelRange();
      editor.executeEdits('external', [{ range, text: value, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    } else {
      // Another element has focus — pushEditOperations doesn't steal focus
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: value }],
        () => null,
      );
    }
  }, [value]);

  const handleChange = useCallback((newValue: string | undefined) => {
    onChange(newValue || '');
  }, [onChange]);

  // Store latest value in a ref so handleEditorMount can read it
  const valueRef = useRef(value);
  valueRef.current = value;

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;

    // Set initial value (we don't pass `value` prop to <Editor>)
    if (valueRef.current && editor.getValue() !== valueRef.current) {
      editor.setValue(valueRef.current);
    }

    // Configure Monaco themes
    monacoInstance.editor.defineTheme('atlas-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#d4d4d4',
        'editor.lineHighlightBackground': '#2a2a2a',
        'editorCursor.foreground': '#ffffff',
        'editorWhitespace.foreground': '#404040',
      },
    });
    monacoInstance.editor.defineTheme('atlas-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#1f2328',
        'editor.lineHighlightBackground': '#f6f8fa',
        'editorCursor.foreground': '#1f2328',
        'editorWhitespace.foreground': '#d0d7de',
      },
    });
    monacoInstance.editor.setTheme(resolved === 'light' ? 'atlas-light' : 'atlas-dark');
    editorMountedRef.current = true;

    // Keyboard shortcuts
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      // Trigger save (parent component should handle)
      console.log('Save shortcut triggered');
    });
  };

  // Switch Monaco theme reactively when resolved theme changes
  useEffect(() => {
    if (!editorMountedRef.current) return;
    monaco.editor.setTheme(resolved === 'light' ? 'atlas-light' : 'atlas-dark');
  }, [resolved]);

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        language={language}
        onChange={handleChange}
        onMount={handleEditorMount}
        options={{
          readOnly,
          minimap: { enabled: true },
          fontSize: 14,
          lineNumbers: 'on',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
          formatOnPaste: true,
          formatOnType: true,
        }}
      />
    </div>
  );
}

export default CodeEditor;
