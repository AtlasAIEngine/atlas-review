/**
 * File Tree Component
 * Displays project files and folders in a recursive tree view
 * Loads subdirectories lazily on expand
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { projectApi } from '@/services/api';
import type { FileItem } from '@/types';
import { useThemeStore } from '@/stores/themeStore';

interface FileTreeProps {
  projectId: string;
  onSelectFile: (path: string, content: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children: TreeNode[] | null; // null = not yet loaded
}

function ChevronRightIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M3.5 2 6.5 5 3.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ isOpen, resolved }: { isOpen: boolean; resolved: ResolvedTheme }) {
  const primaryStroke = resolved === 'light'
    ? (isOpen ? 'rgba(198, 142, 34, 0.96)' : 'rgba(182, 131, 31, 0.9)')
    : (isOpen ? 'rgba(248, 196, 86, 0.98)' : 'rgba(232, 178, 70, 0.92)');
  const secondaryStroke = resolved === 'light'
    ? (isOpen ? 'rgba(212, 166, 74, 0.58)' : 'rgba(196, 150, 62, 0.5)')
    : (isOpen ? 'rgba(248, 196, 86, 0.65)' : 'rgba(232, 178, 70, 0.55)');

  return (
    <svg width="18" height="16" viewBox="0 0 18 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.25c0-.97.78-1.75 1.75-1.75h3.1c.4 0 .78.14 1.08.41l1.1 1c.3.27.68.41 1.08.41h4.14c.97 0 1.75.78 1.75 1.75v5.68c0 .97-.78 1.75-1.75 1.75H3.25c-.97 0-1.75-.78-1.75-1.75V4.25Z"
        stroke={primaryStroke}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M1.9 5.25h13.95"
        stroke={secondaryStroke}
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

type FileIconKind =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'html'
  | 'python'
  | 'image'
  | 'shell'
  | 'config'
  | 'lock'
  | 'env'
  | 'package'
  | 'generic';

interface FileIconPalette {
  pageFill: string;
  pageStroke: string;
  foldFill: string;
  foldStroke: string;
  accent: string;
  accentSoft: string;
}

type ResolvedTheme = 'light' | 'dark';

function getFileIconKind(name: string): FileIconKind {
  const lowerName = name.toLowerCase();

  if (lowerName === 'package.json' || lowerName === 'package-lock.json') {
    return 'package';
  }

  if (lowerName.endsWith('.d.ts') || lowerName.endsWith('.ts') || lowerName.endsWith('.tsx')) {
    return 'typescript';
  }

  if (lowerName.endsWith('.json')) {
    return 'json';
  }

  if (
    lowerName.endsWith('.js') ||
    lowerName.endsWith('.jsx') ||
    lowerName.endsWith('.mjs') ||
    lowerName.endsWith('.cjs')
  ) {
    return 'javascript';
  }

  if (lowerName.endsWith('.md')) {
    return 'markdown';
  }

  if (lowerName.endsWith('.html')) {
    return 'html';
  }

  if (lowerName.endsWith('.py')) {
    return 'python';
  }

  if (
    lowerName.endsWith('.svg') ||
    lowerName.endsWith('.png') ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg') ||
    lowerName.endsWith('.gif') ||
    lowerName.endsWith('.webp')
  ) {
    return 'image';
  }

  if (lowerName.endsWith('.sh')) {
    return 'shell';
  }

  if (
    lowerName.endsWith('.css') ||
    lowerName.endsWith('.scss') ||
    lowerName.endsWith('.yaml') ||
    lowerName.endsWith('.yml') ||
    lowerName.endsWith('.toml')
  ) {
    return 'config';
  }

  if (lowerName.endsWith('.lock')) {
    return 'lock';
  }

  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return 'env';
  }

  return 'generic';
}

function getFileIconPalette(kind: FileIconKind, resolved: ResolvedTheme): FileIconPalette {
  if (resolved === 'light') {
    switch (kind) {
      case 'typescript':
        return {
          pageFill: 'rgba(223, 237, 255, 0.98)',
          pageStroke: 'rgba(82, 138, 214, 0.9)',
          foldFill: 'rgba(202, 227, 255, 0.92)',
          foldStroke: 'rgba(112, 165, 232, 0.74)',
          accent: 'rgba(46, 117, 210, 0.98)',
          accentSoft: 'rgba(225, 241, 255, 0.98)',
        };
      case 'javascript':
        return {
          pageFill: 'rgba(255, 247, 214, 0.98)',
          pageStroke: 'rgba(181, 132, 20, 0.88)',
          foldFill: 'rgba(255, 240, 186, 0.92)',
          foldStroke: 'rgba(214, 168, 55, 0.72)',
          accent: 'rgba(198, 143, 24, 0.98)',
          accentSoft: 'rgba(255, 248, 219, 0.98)',
        };
      case 'json':
        return {
          pageFill: 'rgba(247, 240, 226, 0.98)',
          pageStroke: 'rgba(160, 128, 74, 0.86)',
          foldFill: 'rgba(241, 232, 212, 0.94)',
          foldStroke: 'rgba(188, 160, 113, 0.72)',
          accent: 'rgba(150, 118, 67, 0.98)',
          accentSoft: 'rgba(250, 245, 236, 0.98)',
        };
      case 'markdown':
        return {
          pageFill: 'rgba(255, 248, 223, 0.98)',
          pageStroke: 'rgba(189, 138, 27, 0.9)',
          foldFill: 'rgba(255, 239, 189, 0.92)',
          foldStroke: 'rgba(219, 171, 66, 0.74)',
          accent: 'rgba(202, 146, 25, 0.98)',
          accentSoft: 'rgba(255, 255, 255, 0.98)',
        };
      case 'html':
        return {
          pageFill: 'rgba(222, 247, 250, 0.98)',
          pageStroke: 'rgba(37, 150, 173, 0.88)',
          foldFill: 'rgba(203, 240, 245, 0.92)',
          foldStroke: 'rgba(91, 188, 205, 0.72)',
          accent: 'rgba(34, 145, 168, 0.98)',
          accentSoft: 'rgba(240, 254, 255, 0.98)',
        };
      case 'python':
        return {
          pageFill: 'rgba(230, 239, 252, 0.98)',
          pageStroke: 'rgba(69, 119, 189, 0.88)',
          foldFill: 'rgba(255, 239, 191, 0.92)',
          foldStroke: 'rgba(220, 177, 62, 0.72)',
          accent: 'rgba(56, 113, 190, 0.98)',
          accentSoft: 'rgba(214, 170, 49, 0.98)',
        };
      case 'image':
        return {
          pageFill: 'rgba(232, 239, 250, 0.98)',
          pageStroke: 'rgba(100, 130, 176, 0.86)',
          foldFill: 'rgba(219, 230, 246, 0.92)',
          foldStroke: 'rgba(135, 162, 203, 0.72)',
          accent: 'rgba(84, 118, 170, 0.98)',
          accentSoft: 'rgba(245, 250, 255, 0.98)',
        };
      case 'shell':
        return {
          pageFill: 'rgba(239, 242, 247, 0.98)',
          pageStroke: 'rgba(101, 115, 136, 0.84)',
          foldFill: 'rgba(228, 234, 241, 0.92)',
          foldStroke: 'rgba(141, 154, 173, 0.72)',
          accent: 'rgba(86, 101, 121, 0.98)',
          accentSoft: 'rgba(241, 245, 250, 0.98)',
        };
      case 'config':
        return {
          pageFill: 'rgba(255, 247, 220, 0.98)',
          pageStroke: 'rgba(181, 132, 20, 0.88)',
          foldFill: 'rgba(255, 239, 189, 0.92)',
          foldStroke: 'rgba(214, 168, 55, 0.72)',
          accent: 'rgba(195, 142, 24, 0.98)',
          accentSoft: 'rgba(255, 248, 219, 0.98)',
        };
      case 'lock':
        return {
          pageFill: 'rgba(240, 243, 248, 0.98)',
          pageStroke: 'rgba(114, 126, 146, 0.84)',
          foldFill: 'rgba(231, 236, 242, 0.92)',
          foldStroke: 'rgba(151, 162, 179, 0.72)',
          accent: 'rgba(120, 131, 148, 0.98)',
          accentSoft: 'rgba(250, 252, 255, 0.98)',
        };
      case 'env':
        return {
          pageFill: 'rgba(255, 247, 220, 0.98)',
          pageStroke: 'rgba(181, 132, 20, 0.88)',
          foldFill: 'rgba(255, 239, 189, 0.92)',
          foldStroke: 'rgba(214, 168, 55, 0.72)',
          accent: 'rgba(194, 140, 20, 0.98)',
          accentSoft: 'rgba(255, 246, 208, 0.98)',
        };
      case 'package':
        return {
          pageFill: 'rgba(241, 244, 249, 0.98)',
          pageStroke: 'rgba(109, 121, 139, 0.84)',
          foldFill: 'rgba(232, 237, 244, 0.92)',
          foldStroke: 'rgba(150, 162, 179, 0.72)',
          accent: 'rgba(104, 116, 133, 0.98)',
          accentSoft: 'rgba(248, 250, 253, 0.98)',
        };
      case 'generic':
        return {
          pageFill: 'rgba(246, 248, 252, 0.98)',
          pageStroke: 'rgba(128, 139, 156, 0.82)',
          foldFill: 'rgba(237, 241, 246, 0.92)',
          foldStroke: 'rgba(160, 171, 188, 0.68)',
          accent: 'rgba(115, 127, 145, 0.94)',
          accentSoft: 'rgba(234, 239, 246, 0.98)',
        };
    }
  }

  switch (kind) {
    case 'typescript':
      return {
        pageFill: 'rgba(43, 89, 157, 0.2)',
        pageStroke: 'rgba(112, 183, 255, 0.96)',
        foldFill: 'rgba(112, 183, 255, 0.16)',
        foldStroke: 'rgba(145, 200, 255, 0.84)',
        accent: 'rgba(90, 176, 255, 0.98)',
        accentSoft: 'rgba(193, 227, 255, 0.96)',
      };
    case 'javascript':
      return {
        pageFill: 'rgba(90, 72, 18, 0.22)',
        pageStroke: 'rgba(246, 204, 94, 0.96)',
        foldFill: 'rgba(246, 204, 94, 0.16)',
        foldStroke: 'rgba(255, 231, 163, 0.84)',
        accent: 'rgba(246, 204, 94, 0.98)',
        accentSoft: 'rgba(255, 244, 199, 0.98)',
      };
    case 'json':
      return {
        pageFill: 'rgba(99, 84, 53, 0.18)',
        pageStroke: 'rgba(221, 204, 173, 0.94)',
        foldFill: 'rgba(221, 204, 173, 0.12)',
        foldStroke: 'rgba(232, 219, 196, 0.8)',
        accent: 'rgba(232, 219, 196, 0.96)',
        accentSoft: 'rgba(246, 239, 224, 0.96)',
      };
    case 'markdown':
      return {
        pageFill: 'rgba(91, 65, 18, 0.22)',
        pageStroke: 'rgba(247, 196, 96, 0.98)',
        foldFill: 'rgba(247, 196, 96, 0.14)',
        foldStroke: 'rgba(255, 232, 180, 0.86)',
        accent: 'rgba(247, 196, 96, 0.98)',
        accentSoft: 'rgba(247, 250, 255, 0.96)',
      };
    case 'html':
      return {
        pageFill: 'rgba(22, 72, 84, 0.2)',
        pageStroke: 'rgba(92, 212, 234, 0.96)',
        foldFill: 'rgba(92, 212, 234, 0.12)',
        foldStroke: 'rgba(157, 235, 249, 0.82)',
        accent: 'rgba(92, 212, 234, 0.96)',
        accentSoft: 'rgba(208, 247, 255, 0.96)',
      };
    case 'python':
      return {
        pageFill: 'rgba(40, 62, 108, 0.22)',
        pageStroke: 'rgba(107, 171, 241, 0.96)',
        foldFill: 'rgba(244, 202, 88, 0.12)',
        foldStroke: 'rgba(244, 202, 88, 0.84)',
        accent: 'rgba(107, 171, 241, 0.96)',
        accentSoft: 'rgba(244, 202, 88, 0.98)',
      };
    case 'image':
      return {
        pageFill: 'rgba(52, 69, 96, 0.22)',
        pageStroke: 'rgba(161, 190, 225, 0.94)',
        foldFill: 'rgba(161, 190, 225, 0.1)',
        foldStroke: 'rgba(196, 217, 242, 0.82)',
        accent: 'rgba(161, 190, 225, 0.96)',
        accentSoft: 'rgba(225, 238, 255, 0.96)',
      };
    case 'shell':
      return {
        pageFill: 'rgba(55, 62, 75, 0.24)',
        pageStroke: 'rgba(189, 198, 213, 0.94)',
        foldFill: 'rgba(189, 198, 213, 0.1)',
        foldStroke: 'rgba(217, 224, 236, 0.8)',
        accent: 'rgba(224, 231, 240, 0.96)',
        accentSoft: 'rgba(240, 244, 249, 0.96)',
      };
    case 'config':
      return {
        pageFill: 'rgba(92, 66, 18, 0.22)',
        pageStroke: 'rgba(243, 193, 93, 0.96)',
        foldFill: 'rgba(243, 193, 93, 0.12)',
        foldStroke: 'rgba(255, 226, 155, 0.82)',
        accent: 'rgba(243, 193, 93, 0.98)',
        accentSoft: 'rgba(255, 242, 207, 0.96)',
      };
    case 'lock':
      return {
        pageFill: 'rgba(74, 80, 92, 0.24)',
        pageStroke: 'rgba(217, 224, 234, 0.94)',
        foldFill: 'rgba(217, 224, 234, 0.1)',
        foldStroke: 'rgba(241, 244, 249, 0.82)',
        accent: 'rgba(217, 224, 234, 0.96)',
        accentSoft: 'rgba(244, 247, 252, 0.96)',
      };
    case 'env':
      return {
        pageFill: 'rgba(92, 68, 18, 0.24)',
        pageStroke: 'rgba(241, 197, 95, 0.96)',
        foldFill: 'rgba(241, 197, 95, 0.12)',
        foldStroke: 'rgba(255, 230, 161, 0.84)',
        accent: 'rgba(241, 197, 95, 0.98)',
        accentSoft: 'rgba(255, 239, 196, 0.98)',
      };
    case 'package':
      return {
        pageFill: 'rgba(76, 81, 90, 0.22)',
        pageStroke: 'rgba(220, 226, 236, 0.96)',
        foldFill: 'rgba(220, 226, 236, 0.1)',
        foldStroke: 'rgba(243, 246, 251, 0.82)',
        accent: 'rgba(220, 226, 236, 0.98)',
        accentSoft: 'rgba(243, 246, 251, 0.98)',
      };
    case 'generic':
      return {
        pageFill: 'rgba(69, 77, 93, 0.1)',
        pageStroke: 'rgba(127, 140, 163, 0.88)',
        foldFill: 'rgba(127, 140, 163, 0.06)',
        foldStroke: 'rgba(127, 140, 163, 0.72)',
        accent: 'rgba(181, 191, 208, 0.92)',
        accentSoft: 'rgba(224, 231, 241, 0.92)',
      };
  }
}

function FileIconBadge({ kind, palette }: { kind: FileIconKind; palette: FileIconPalette }) {
  switch (kind) {
    case 'typescript':
      return (
        <>
          <path d="M6.3 8.4 10.35 12.45 6.3 16.5 2.25 12.45 6.3 8.4Z" fill={palette.accent} />
          <path d="M6.3 8.4 10.35 12.45 6.3 16.5 2.25 12.45 6.3 8.4Z" stroke={palette.accentSoft} strokeWidth="0.75" />
        </>
      );
    case 'javascript':
      return (
        <>
          <rect x="2.75" y="9.65" width="7.1" height="5.7" rx="1.35" fill={palette.accent} />
          <rect x="2.75" y="9.65" width="7.1" height="5.7" rx="1.35" stroke={palette.accentSoft} strokeWidth="0.75" />
        </>
      );
    case 'json':
      return (
        <>
          <path d="M4.65 9.95c-.82.35-1.22 1.02-1.22 2.02s.4 1.68 1.22 2.02M7.95 9.95c.82.35 1.22 1.02 1.22 2.02s-.4 1.68-1.22 2.02" stroke={palette.accentSoft} strokeWidth="1.05" strokeLinecap="round" />
          <path d="M6.28 9.4v5.25" stroke={palette.accent} strokeWidth="0.95" strokeLinecap="round" opacity="0.5" />
        </>
      );
    case 'html':
      return (
        <>
          <circle cx="6.3" cy="12.35" r="3.05" stroke={palette.accent} strokeWidth="0.95" />
          <path d="M3.45 12.35h5.7M6.3 9.3c1 .92 1.62 1.94 1.62 3.05S7.3 14.48 6.3 15.4M6.3 9.3c-1 .92-1.62 1.94-1.62 3.05s.62 2.13 1.62 3.05" stroke={palette.accentSoft} strokeWidth="0.82" strokeLinecap="round" />
        </>
      );
    case 'markdown':
      return (
        <>
          <path d="M3.55 14.1 8.8 8.85l1.68 1.68-5.26 5.27H3.55V14.1Z" fill={palette.accent} />
          <path d="M8.35 8.4 9.8 6.95c.36-.36.94-.36 1.3 0l.58.58c.36.36.36.94 0 1.3l-1.45 1.45L8.35 8.4Z" fill={palette.accentSoft} />
          <path d="M3.95 15.25h2.15" stroke={palette.accentSoft} strokeWidth="0.85" strokeLinecap="round" />
        </>
      );
    case 'python':
      return (
        <>
          <path d="M3.25 10.15c0-.78.63-1.42 1.42-1.42H6.9c.78 0 1.42.64 1.42 1.42v1.48c0 .79-.64 1.42-1.42 1.42H4.67c-.79 0-1.42-.63-1.42-1.42v-1.48Z" fill={palette.accent} />
          <path d="M5.62 8.73h2.23c.79 0 1.43.64 1.43 1.42v1.48c0 .79-.64 1.42-1.43 1.42H5.62" stroke={palette.accentSoft} strokeWidth="1.05" strokeLinecap="round" />
          <circle cx="5.15" cy="10.65" r=".42" fill="rgba(240,247,255,0.98)" />
          <circle cx="7.85" cy="11.7" r=".42" fill="rgba(255,249,219,0.98)" />
        </>
      );
    case 'image':
      return (
        <>
          <circle cx="4.5" cy="10.15" r=".85" fill={palette.accentSoft} />
          <path d="M3.3 14.75 5.75 11.95 7.15 13.3 9.3 10.95 10.45 14.75" stroke={palette.accent} strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3.15 14.95h7" stroke={palette.accentSoft} strokeWidth="0.82" strokeLinecap="round" />
        </>
      );
    case 'shell':
      return (
        <>
          <path d="M3.5 10.35 5.45 12 3.5 13.65" stroke={palette.accent} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6.5 13.6h2.45" stroke={palette.accentSoft} strokeWidth="1.05" strokeLinecap="round" />
        </>
      );
    case 'config':
      return (
        <>
          <circle cx="6.35" cy="12.35" r="2.5" stroke={palette.accent} strokeWidth="0.92" />
          <circle cx="6.35" cy="12.35" r=".92" fill={palette.accentSoft} />
          <path d="M6.35 8.85v1.1M6.35 14.75v1.1M2.85 12.35h1.1M8.75 12.35h1.1M3.92 9.92l.78.78M8 14l.78.78M8.78 9.92 8 10.7M4.7 14 3.92 14.78" stroke={palette.accent} strokeWidth="0.82" strokeLinecap="round" />
        </>
      );
    case 'lock':
      return (
        <>
          <rect x="4.1" y="11.35" width="4.65" height="4.25" rx="0.95" fill={palette.accent} opacity="0.16" stroke={palette.accent} strokeWidth="0.85" />
          <path d="M5.05 11.35v-1.02c0-.94.62-1.58 1.38-1.58.75 0 1.37.64 1.37 1.58v1.02" stroke={palette.accentSoft} strokeWidth="0.9" strokeLinecap="round" />
          <circle cx="6.42" cy="13.4" r=".48" fill={palette.accentSoft} />
        </>
      );
    case 'env':
      return (
        <>
          <circle cx="4.75" cy="11.95" r="1.35" fill={palette.accent} />
          <path d="M5.85 12.95 9.7 16.8M6.2 11.95h2.8M8.15 10.95v2M9.1 11.45v1" stroke={palette.accentSoft} strokeWidth="0.9" strokeLinecap="round" />
        </>
      );
    case 'package':
      return (
        <>
          <path d="M3.45 10.25 6.3 8.8l2.85 1.45-2.85 1.52-2.85-1.52Z" fill={palette.accent} opacity="0.22" stroke={palette.accent} strokeWidth="0.82" strokeLinejoin="round" />
          <path d="M3.45 10.25v3.45L6.3 15.2l2.85-1.5v-3.45" stroke={palette.accentSoft} strokeWidth="0.88" strokeLinejoin="round" />
          <path d="M6.3 11.77v3.3" stroke={palette.accent} strokeWidth="0.82" strokeLinecap="round" />
        </>
      );
    case 'generic':
      return null;
  }
}

function FileIcon({ name, resolved }: { name: string; resolved: ResolvedTheme }) {
  const kind = getFileIconKind(name);
  const palette = getFileIconPalette(kind, resolved);

  return (
    <svg width="15" height="17" viewBox="0 0 15 17" fill="none" aria-hidden="true">
      <path
        d="M3.25 1.25h5.4l3.1 3.1v9.4c0 .83-.67 1.5-1.5 1.5h-7c-.83 0-1.5-.67-1.5-1.5v-11c0-.83.67-1.5 1.5-1.5Z"
        fill={palette.pageFill}
        stroke={palette.pageStroke}
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path d="M8.6 1.55v2.6c0 .55.45 1 1 1h2.6" fill={palette.foldFill} stroke={palette.foldStroke} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 6.75h5.55" stroke={palette.foldStroke} strokeOpacity="0.45" strokeWidth="0.8" strokeLinecap="round" />
      <FileIconBadge kind={kind} palette={palette} />
    </svg>
  );
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  resolved: ResolvedTheme;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
}

function TreeNodeRow({
  node,
  depth,
  resolved,
  expandedPaths,
  loadingPaths,
  selectedPath,
  onToggle,
  onSelect,
}: TreeNodeRowProps) {
  const isLight = resolved === 'light';
  const isDir = node.type === 'directory';
  const isExpanded = expandedPaths.has(node.path);
  const isLoading = loadingPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const expandIndicator = isLoading ? (
    <span
      className="inline-block h-2.5 w-2.5 animate-spin rounded-full border"
      style={{
        borderColor: isLight ? 'rgba(190, 150, 62, 0.28)' : 'rgba(248,196,86,0.38)',
        borderTopColor: isLight ? 'rgba(190, 150, 62, 0.94)' : 'rgba(248,196,86,0.98)',
      }}
    />
  ) : isExpanded ? (
    <ChevronDownIcon />
  ) : (
    <ChevronRightIcon />
  );
  const selectedRowClass = isLight
    ? 'border-[rgba(89,134,198,0.34)] bg-[rgba(228,238,252,0.98)] text-[rgba(27,45,72,0.98)] shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_0_0_1px_rgba(9,105,218,0.04)]'
    : 'border-[rgba(92,125,182,0.42)] bg-[rgba(19,28,44,0.92)] text-[rgba(244,247,255,0.98)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_0_0_1px_rgba(88,166,255,0.04)]';
  const defaultRowClass = isLight
    ? 'border-transparent bg-transparent text-[rgba(102,114,132,0.92)] hover:border-[rgba(186,197,213,0.62)] hover:bg-[rgba(242,246,251,0.98)] hover:text-[rgba(35,45,57,0.98)]'
    : 'border-transparent bg-transparent text-[rgba(180,189,205,0.9)] hover:border-[rgba(72,84,110,0.32)] hover:bg-[rgba(15,22,35,0.92)] hover:text-[rgba(235,239,246,0.96)]';
  const caretClass = isLight ? 'text-[rgba(122,133,148,0.9)]' : 'text-[rgba(117,128,146,0.9)]';
  const dirTextClass = isLight ? 'font-medium text-[rgba(36,44,56,0.96)]' : 'font-medium text-[rgba(247,249,253,0.96)]';
  const fileTextClass = isLight ? 'font-normal text-[rgba(90,101,118,0.96)]' : 'font-normal text-[rgba(177,186,202,0.92)]';
  const selectedTextClass = isLight ? 'text-[rgba(23,41,67,0.98)]' : 'text-[rgba(248,250,255,0.98)]';

  return (
    <>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node))}
        className={`group relative flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-all
          ${isSelected ? selectedRowClass : defaultRowClass}`}
        style={{ paddingLeft: `${depth * 18 + 10}px` }}
        title={node.path}
      >
        <span className={`flex w-3.5 flex-shrink-0 items-center justify-center ${isDir ? caretClass : ''}`}>
          {isDir ? expandIndicator : null}
        </span>
        <span className="flex-shrink-0">
          {isDir ? <FolderIcon isOpen={isExpanded} resolved={resolved} /> : <FileIcon name={node.name} resolved={resolved} />}
        </span>
        <span
          className={`min-w-0 truncate text-[13px] tracking-[-0.01em] ${
            isDir ? dirTextClass : fileTextClass
          } ${isSelected ? selectedTextClass : ''}`}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {node.name}
        </span>
      </button>
      {isDir && isExpanded && node.children && (
        <>
          {sortNodes(node.children).map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              resolved={resolved}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
          {node.children.length === 0 && (
            <div
              className={`py-0.5 text-xs italic ${isLight ? 'text-[rgba(122,132,145,0.9)]' : 'text-[rgba(114,123,139,0.88)]'}`}
              style={{ paddingLeft: `${(depth + 1) * 18 + 34}px`, fontFamily: 'var(--font-mono)' }}
            >
              Empty folder
            </div>
          )}
        </>
      )}
    </>
  );
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const lower = query.toLowerCase();
  return nodes
    .map((node) => {
      if (node.type === 'directory') {
        const filteredChildren = node.children ? filterTree(node.children, query) : null;
        if (filteredChildren && filteredChildren.length > 0) {
          return { ...node, children: filteredChildren };
        }
        // Also match directory name itself
        if (node.name.toLowerCase().includes(lower)) return node;
        return null;
      }
      if (node.name.toLowerCase().includes(lower)) return node;
      return null;
    })
    .filter((n): n is TreeNode => n !== null);
}

function collectDirPaths(nodes: TreeNode[]): Set<string> {
  const paths = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'directory') {
      paths.add(n.path);
      if (n.children) {
        for (const p of collectDirPaths(n.children)) paths.add(p);
      }
    }
  }
  return paths;
}

function FileTree({ projectId, onSelectFile }: FileTreeProps) {
  const resolved = useThemeStore((s) => s.resolved);
  const isLight = resolved === 'light';
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [filterText, setFilterText] = useState('');

  const filesToNodes = (files: FileItem[]): TreeNode[] =>
    files.map((f) => ({
      name: f.name,
      path: f.path,
      type: f.type,
      children: f.type === 'directory' ? null : undefined as unknown as null,
    }));

  // Load root
  useEffect(() => {
    setRootNodes([]);
    setExpandedPaths(new Set());
    setSelectedPath(null);
    setLoadError(null);
    setInitialLoading(true);

    projectApi
      .listFiles(projectId, '')
      .then((res) => setRootNodes(sortNodes(filesToNodes(res.files))))
      .catch(() => setLoadError('Failed to load files'))
      .finally(() => setInitialLoading(false));
  }, [projectId]);

  const loadChildren = useCallback(
    async (dirPath: string) => {
      setLoadingPaths((prev) => new Set(prev).add(dirPath));
      try {
        const res = await projectApi.listFiles(projectId, dirPath);
        const children = sortNodes(filesToNodes(res.files));

        // Update the tree by finding the node and setting its children
        const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.path === dirPath) return { ...n, children };
            if (n.type === 'directory' && n.children) {
              return { ...n, children: updateNodes(n.children) };
            }
            return n;
          });

        setRootNodes((prev) => updateNodes(prev));
      } catch {
        // Keep children as null so collapsing and re-expanding retries the request.
        const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.path === dirPath) return { ...n, children: null };
            if (n.type === 'directory' && n.children) {
              return { ...n, children: updateNodes(n.children) };
            }
            return n;
          });
        setRootNodes((prev) => updateNodes(prev));
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [projectId],
  );

  const handleToggle = useCallback(
    (dirPath: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          // Load children if not yet loaded
          const findNode = (nodes: TreeNode[]): TreeNode | undefined => {
            for (const n of nodes) {
              if (n.path === dirPath) return n;
              if (n.children) {
                const found = findNode(n.children);
                if (found) return found;
              }
            }
            return undefined;
          };
          const node = findNode(rootNodes);
          if (node && node.children === null) {
            loadChildren(dirPath);
          }
        }
        return next;
      });
    },
    [rootNodes, loadChildren],
  );

  const handleSelect = useCallback(
    async (node: TreeNode) => {
      setSelectedPath(node.path);
      try {
        const response = await projectApi.getFileContent(projectId, node.path);
        onSelectFile(node.path, response.content);
      } catch (error) {
        console.error('Failed to load file:', error);
      }
    },
    [projectId, onSelectFile],
  );

  const isFiltering = filterText.trim().length > 0;

  const filteredNodes = useMemo(
    () => (isFiltering ? filterTree(rootNodes, filterText.trim()) : rootNodes),
    [rootNodes, filterText, isFiltering],
  );

  // When filtering, auto-expand all directories so matches are visible
  const displayExpandedPaths = useMemo(
    () => (isFiltering ? collectDirPaths(filteredNodes) : expandedPaths),
    [isFiltering, filteredNodes, expandedPaths],
  );

  if (initialLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className={`text-sm ${isLight ? 'text-[rgba(116,127,142,0.9)]' : 'text-[rgba(121,132,149,0.9)]'}`} style={{ fontFamily: 'var(--font-mono)' }}>
          Loading files...
        </div>
      </div>
    );
  }

  if (loadError && rootNodes.length === 0) {
    return (
      <div className="p-3">
        <div className="mb-2 text-sm text-accent-red">{loadError}</div>
        <button
          type="button"
          onClick={() => {
            setLoadError(null);
            setInitialLoading(true);
            projectApi
              .listFiles(projectId, '')
              .then((res) => setRootNodes(sortNodes(filesToNodes(res.files))))
              .catch(() => setLoadError('Failed to load files'))
              .finally(() => setInitialLoading(false));
          }}
          className={`rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
            isLight
              ? 'border-[rgba(161,174,193,0.56)] text-[rgba(64,74,87,0.92)] hover:bg-[rgba(238,243,249,0.96)]'
              : 'border-[rgba(86,100,124,0.44)] text-[rgba(220,226,236,0.92)] hover:bg-[rgba(17,24,37,0.88)]'
          }`}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={`flex h-full flex-col ${
      isLight
        ? 'bg-[linear-gradient(180deg,rgba(251,253,255,0.98)_0%,rgba(245,248,252,0.98)_100%)]'
        : 'bg-[linear-gradient(180deg,rgba(8,12,20,0.96)_0%,rgba(10,15,24,0.98)_100%)]'
    }`}>
      <div className={`border-b px-3 pb-3 pt-3 ${
        isLight
          ? 'border-[rgba(170,183,201,0.38)] bg-[rgba(245,248,252,0.94)]'
          : 'border-[rgba(71,83,106,0.34)] bg-[rgba(8,12,19,0.92)]'
      }`}>
        <div className="mb-2 flex items-center justify-between">
          <span
            className={`text-[11px] uppercase tracking-[0.16em] ${
              isLight ? 'text-[rgba(102,113,129,0.9)]' : 'text-[rgba(121,132,149,0.9)]'
            }`}
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Explorer
          </span>
          <span
            className={`text-[10px] ${isLight ? 'text-[rgba(121,131,145,0.86)]' : 'text-[rgba(99,110,128,0.82)]'}`}
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {rootNodes.length} root
          </span>
        </div>
        <input
          type="text"
          placeholder="Filter files"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none ${
            isLight
              ? 'text-[rgba(47,58,71,0.96)] placeholder:text-[rgba(126,136,149,0.84)]'
              : 'text-[rgba(235,239,246,0.96)] placeholder:text-[rgba(107,119,137,0.82)]'
          }`}
          style={{
            fontFamily: 'var(--font-mono)',
            background: isLight
              ? 'linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(246, 249, 253, 0.98) 100%)'
              : 'linear-gradient(180deg, rgba(10, 14, 22, 0.96) 0%, rgba(8, 12, 19, 0.98) 100%)',
            borderColor: isLight ? 'rgba(172, 184, 201, 0.48)' : 'rgba(69, 82, 108, 0.34)',
            boxShadow: isLight
              ? 'inset 0 1px 0 rgba(255,255,255,0.72)'
              : 'inset 0 1px 0 rgba(255,255,255,0.02)',
          }}
        />
      </div>
      <div className="flex-1 overflow-auto px-2 py-2">
        {filteredNodes.length === 0 ? (
          <div className={`p-3 text-sm ${isLight ? 'text-[rgba(121,131,145,0.9)]' : 'text-[rgba(114,123,139,0.9)]'}`} style={{ fontFamily: 'var(--font-mono)' }}>
            {isFiltering ? `No files match "${filterText}"` : 'No files yet'}
          </div>
        ) : (
          sortNodes(filteredNodes).map((node) => (
            <TreeNodeRow
              key={node.path}
              node={node}
              depth={0}
              resolved={resolved}
              expandedPaths={displayExpandedPaths}
              loadingPaths={loadingPaths}
              selectedPath={selectedPath}
              onToggle={handleToggle}
              onSelect={handleSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default FileTree;
