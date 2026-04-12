import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, ChevronRight, Folder, Image, Video } from 'lucide-react';
import type { FileTreeNode, FileSelection } from '../../../shared/types.js';
import { formatBytes } from '../lib/utils';
import BottomPanel from './BottomPanel';

interface FileTreePanelProps {
  visible: boolean;
  mode: 'view' | 'select';
  tree: FileTreeNode[];
  initialSelection?: FileSelection | null;
  expandedPaths: Set<string> | null;
  onExpandedPathsChange: (paths: Set<string> | null) => void;
  onImageSelect?: (imagePath: string) => void;
  focusPath?: string;
  onConfirm?: (selection: FileSelection) => void;
  onClose: () => void;
}

/** Collect all leaf file paths under a node */
function collectFiles(node: FileTreeNode): { images: string[]; videos: string[] } {
  if (node.type === 'image') return { images: [node.path], videos: [] };
  if (node.type === 'video') return { images: [], videos: [node.path] };
  const result = { images: [] as string[], videos: [] as string[] };
  for (const child of node.children ?? []) {
    const childFiles = collectFiles(child);
    result.images.push(...childFiles.images);
    result.videos.push(...childFiles.videos);
  }
  return result;
}

/** Get all ancestor folder paths for a given file path (e.g. "a/b/c.png" → ["a", "a/b"]) */
function getAncestorPaths(filePath: string): string[] {
  const parts = filePath.split('/');
  if (parts.length <= 1) return [];
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

function TreeNode({
  node,
  depth,
  mode,
  expandedPaths,
  selectedPaths,
  onToggleExpand,
  onToggleSelect,
  onImageClick,
}: {
  node: FileTreeNode;
  depth: number;
  mode: 'view' | 'select';
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
  onToggleSelect: (node: FileTreeNode) => void;
  onImageClick?: (path: string) => void;
}) {
  const isExpanded = expandedPaths.has(node.path);
  const isFolder = node.type === 'folder';

  let checkState: 'unchecked' | 'checked' | 'indeterminate' = 'unchecked';
  if (mode === 'select' && isFolder) {
    const files = collectFiles(node);
    const allFiles = [...files.images, ...files.videos];
    const selectedCount = allFiles.filter(f => selectedPaths.has(f)).length;
    if (selectedCount === 0) checkState = 'unchecked';
    else if (selectedCount === allFiles.length) checkState = 'checked';
    else checkState = 'indeterminate';
  } else if (mode === 'select') {
    checkState = selectedPaths.has(node.path) ? 'checked' : 'unchecked';
  }

  const allFilesCount = useMemo(() => {
    if (!isFolder) return 0;
    const files = collectFiles(node);
    return files.images.length + files.videos.length;
  }, [isFolder, node]);

  return (
    <div>
      <div
        data-tree-path={node.path}
        className={`flex items-center py-1.5 rounded transition-colors ${
          isFolder ? 'sticky bg-gray-900 z-10 cursor-pointer hover:bg-gray-800' : ''
        } ${
          mode === 'view' && node.type === 'image'
            ? 'cursor-pointer hover:bg-gray-800'
            : mode === 'select'
              ? 'cursor-pointer hover:bg-gray-800'
              : ''
        }`}
        style={{ paddingLeft: `${depth * 20 + (mode === 'select' ? 20 : 14)}px`, paddingRight: 16, top: depth * 44 - 5 }}
        onClick={() => {
          if (mode === 'select') {
            onToggleSelect(node);
          } else if (mode === 'view' && node.type === 'image') {
            onImageClick?.(node.path);
          }
        }}
      >
        {/* Checkbox (select mode only) */}
        {mode === 'select' && (
          <div
            className={`relative w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
              checkState === 'checked'
                ? 'bg-blue-600 border-blue-600'
                : checkState === 'indeterminate'
                  ? 'bg-blue-600 border-blue-600'
                  : 'border-gray-600'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(node);
            }}
          >
            {checkState === 'checked' && (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {checkState === 'indeterminate' && (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M2 6H10" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
          </div>
        )}

        {/* Expand/collapse chevron for folders */}
        {isFolder ? (
          <div
            className="flex items-center justify-center w-7 h-7 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.path);
            }}
          >
            <ChevronRight
              size={14}
              className={`text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          </div>
        ) : (
          <span className="w-7 shrink-0" />
        )}

        {/* Icon / Thumbnail */}
        {node.type === 'folder' && <Folder size={16} className="shrink-0 text-gray-400" />}
        {node.type === 'image' && node.thumbUrl && (
          <div className="w-7 h-7 rounded bg-gray-800 shrink-0 overflow-hidden">
            <img
              src={node.thumbUrl}
              alt={node.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
        )}
        {node.type === 'image' && !node.thumbUrl && <Image size={16} className="shrink-0 text-gray-400" />}
        {node.type === 'video' && <Video size={16} className="shrink-0 text-gray-400" />}

        {/* Name + size */}
        <div className="flex items-baseline min-w-0 ml-2 leading-8">
          <span className="text-sm text-gray-300 truncate">{node.name}</span>
          {node.size != null && (
            <span className="text-xs text-gray-400 opacity-50 shrink-0 ml-2">
              {isFolder ? `${allFilesCount} 项 · ${formatBytes(node.size)}` : formatBytes(node.size)}
            </span>
          )}
        </div>
      </div>

      {/* Children */}
      {isFolder && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              mode={mode}
              expandedPaths={expandedPaths}
              selectedPaths={selectedPaths}
              onToggleExpand={onToggleExpand}
              onToggleSelect={onToggleSelect}
              onImageClick={onImageClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTreePanel({ visible, mode, tree, initialSelection, expandedPaths, onExpandedPathsChange, onImageSelect, focusPath, onConfirm, onClose }: FileTreePanelProps) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  // Initialize expanded paths on first render with tree data
  useEffect(() => {
    if (tree.length === 0 || expandedPaths !== null) return;

    const initialExpanded = new Set<string>();
    for (const node of tree) {
      if (node.type === 'folder') initialExpanded.add(node.path);
    }
    onExpandedPathsChange(initialExpanded);
  }, [tree, expandedPaths, onExpandedPathsChange]);

  // Expand ancestors for focusPath
  useEffect(() => {
    if (!focusPath || !expandedPaths) return;
    const ancestors = getAncestorPaths(focusPath);
    const needsExpand = ancestors.filter(p => !expandedPaths.has(p));
    if (needsExpand.length > 0) {
      const next = new Set(expandedPaths);
      for (const p of needsExpand) next.add(p);
      onExpandedPathsChange(next);
    }
  }, [focusPath, expandedPaths, onExpandedPathsChange]);

  // Scroll to focusPath (instant when hidden so panel opens at correct position)
  useEffect(() => {
    if (!focusPath || !expandedPaths) return;
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        if (!scrollContainerRef.current) return;
        const escapedPath = focusPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const el = scrollContainerRef.current.querySelector(`[data-tree-path="${escapedPath}"]`);
        if (el) {
          el.scrollIntoView({
            block: 'center',
            behavior: visible ? 'smooth' : 'instant',
            container: 'nearest',
          } as ScrollIntoViewOptions);
        }
      });
      rafRef.current = raf2;
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [visible, focusPath, expandedPaths]);

  // Initialize selection
  useEffect(() => {
    if (mode !== 'select' || tree.length === 0) return;

    if (initialSelection) {
      setSelectedPaths(new Set([...initialSelection.images, ...initialSelection.videos]));
    } else {
      const allPaths = new Set<string>();
      function collectAll(nodes: FileTreeNode[]) {
        for (const n of nodes) {
          if (n.type === 'folder') collectAll(n.children ?? []);
          else allPaths.add(n.path);
        }
      }
      collectAll(tree);
      setSelectedPaths(allPaths);
    }
  }, [mode, initialSelection, tree]);

  const toggleExpand = useCallback((path: string) => {
    const next = new Set(expandedPaths ?? []);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onExpandedPathsChange(next);
  }, [expandedPaths, onExpandedPathsChange]);

  const toggleSelect = useCallback((node: FileTreeNode) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (node.type === 'folder') {
        const files = collectFiles(node);
        const allFiles = [...files.images, ...files.videos];
        const allSelected = allFiles.every(f => prev.has(f));
        if (allSelected) {
          for (const f of allFiles) next.delete(f);
        } else {
          for (const f of allFiles) next.add(f);
        }
      } else {
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
      }
      return next;
    });
  }, []);

  const totalFiles = useMemo(() => {
    let count = 0;
    function countLeaves(nodes: FileTreeNode[]) {
      for (const n of nodes) {
        if (n.type === 'folder') countLeaves(n.children ?? []);
        else count++;
      }
    }
    countLeaves(tree);
    return count;
  }, [tree]);

  const handleConfirm = () => {
    if (!onConfirm) return;
    const images: string[] = [];
    const videos: string[] = [];
    function collect(nodes: FileTreeNode[]) {
      for (const n of nodes) {
        if (n.type === 'folder') collect(n.children ?? []);
        else if (selectedPaths.has(n.path)) {
          if (n.type === 'image') images.push(n.path);
          else if (n.type === 'video') videos.push(n.path);
        }
      }
    }
    collect(tree);
    onConfirm({ images, videos });
  };

  const handleSelectAll = () => {
    const allPaths = new Set<string>();
    function collectAll(nodes: FileTreeNode[]) {
      for (const n of nodes) {
        if (n.type === 'folder') collectAll(n.children ?? []);
        else allPaths.add(n.path);
      }
    }
    collectAll(tree);

    if (selectedPaths.size === allPaths.size) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(allPaths);
    }
  };

  if (tree.length === 0) return null;

  return (
    <BottomPanel visible={visible} keepMounted onClose={onClose}>
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h3 className="text-white font-medium">
          {mode === 'view' ? '文件结构' : '选择文件范围'}
        </h3>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-white transition-colors">
          <X size={20} />
        </button>
      </div>

      {/* Tree body */}
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto py-1">
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            mode={mode}
            expandedPaths={expandedPaths ?? new Set()}
            selectedPaths={selectedPaths}
            onToggleExpand={toggleExpand}
            onToggleSelect={toggleSelect}
            onImageClick={(path) => {
              onImageSelect?.(path);
              onClose();
            }}
          />
        ))}
      </div>

      {/* Footer (select mode only) */}
      {mode === 'select' && (
        <div className="shrink-0 grid grid-cols-3 gap-3 px-4 py-3 border-t border-gray-800">
          <button
            onClick={handleSelectAll}
            className="col-span-1 h-11 bg-gray-800 text-gray-300 text-sm font-medium rounded-xl hover:bg-gray-700 transition-colors"
          >
            {selectedPaths.size === totalFiles ? '取消全选' : '全选'}
          </button>
          <button
            onClick={handleConfirm}
            className="col-span-2 h-11 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-500 transition-colors"
          >
            确认 ({selectedPaths.size}/{totalFiles})
          </button>
        </div>
      )}
    </BottomPanel>
  );
}
