import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { X, ChevronLeft, ChevronRight, FolderTree } from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import type { ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { useImagePool } from '../hooks/useImagePool';
import BlurhashPlaceholder from './BlurhashPlaceholder';

interface ImageItem {
  name: string;
  thumbUrl: string;
  fullUrl: string;
  blurhash?: string | null;
  width?: number | null;
  height?: number | null;
}

interface ImageViewerProps {
  images: ImageItem[];
  initialIndex: number;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
  showFileTreeButton?: boolean;
  onOpenFileTree?: () => void;
  blurhashCache?: Map<string, string>;
}

export default function ImageViewer({ images, initialIndex, onClose, onIndexChange, showFileTreeButton, onOpenFileTree, blurhashCache }: ImageViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showUI, setShowUI] = useState(true);
  const thumbStripRef = useRef<HTMLDivElement>(null);
  const twRef = useRef<ReactZoomPanPinchContentRef>(null);
  const currentScaleRef = useRef(1);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; scale: number } | null>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);

  const { currentImg, wasAlreadyLoaded } = useImagePool(images, currentIndex);
  const currentImage = images[currentIndex];

  // Mount the pooled image element into the container DOM
  // useLayoutEffect runs synchronously before browser paint, preventing empty-frame flash
  useLayoutEffect(() => {
    const container = imgContainerRef.current;
    if (!container) return;
    container.innerHTML = '';
    if (currentImg) {
      const skipAnimation = wasAlreadyLoaded;
      currentImg.style.transition = skipAnimation ? 'none' : 'opacity 150ms';
      currentImg.style.opacity = skipAnimation ? '1' : '0';
      container.appendChild(currentImg);
      if (!skipAnimation) {
        requestAnimationFrame(() => {
          currentImg.style.opacity = '1';
        });
      }
    }
  }, [currentImg]);

  // Sync when external index changes (e.g. from file tree navigation)
  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex]);

  // Notify parent when internal index changes
  useEffect(() => {
    onIndexChange?.(currentIndex);
  }, [currentIndex, onIndexChange]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : images.length - 1));
  }, [images.length]);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i < images.length - 1 ? i + 1 : 0));
  }, [images.length]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, goPrev, goNext]);

  // Prevent body scroll when viewer is open
  const { lock, unlock } = useBodyScrollLock();
  useEffect(() => {
    lock();
    return () => unlock();
  }, [lock, unlock]);

  // Reset zoom on index change
  useEffect(() => {
    twRef.current?.resetTransform();
    currentScaleRef.current = 1;
  }, [currentIndex]);

  // Scroll current thumbnail into view
  useEffect(() => {
    const strip = thumbStripRef.current;
    if (!strip) return;
    const active = strip.children[currentIndex] as HTMLElement | undefined;
    if (active) {
      active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [currentIndex]);

  // Pointer events on outer div: swipe + tap detection
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return;
    pointerStartRef.current = { x: e.clientX, y: e.clientY, scale: currentScaleRef.current };
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return;
    if (!pointerStartRef.current) return;

    const start = pointerStartRef.current;
    pointerStartRef.current = null;

    const dx = start.x - e.clientX;
    const dy = start.y - e.clientY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Horizontal swipe: only when gesture started at scale ~1 and moved significantly
    if (distance >= 20 && start.scale < 1.05 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) goNext();
      else goPrev();
      return;
    }

    // Tap (minimal movement): single → toggle UI, double → zoom toggle
    if (distance < 10) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      } else {
        clickTimerRef.current = setTimeout(() => {
          setShowUI((v) => !v);
          clickTimerRef.current = null;
        }, 300);
      }
    }
  }, [goNext, goPrev]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div className="fixed top-0 left-0 right-0 pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] h-dvh z-50 bg-black select-none box-content">
      <div
        className="absolute inset-0 touch-none"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onTouchEnd={handleTouchEnd}
      >
        <TransformWrapper
          ref={twRef}
          initialScale={1}
          minScale={1}
          maxScale={3}
          doubleClick={{
            step: 0.68,
            mode: 'toggle',
            animationTime: 320,
            animationType: 'easeInOutCubic'
          }}
          wheel={{ step: 0.005 }}
          limitToBounds={true}
          disablePadding={true}
          centerOnInit
          onZoomStop={(ref: ReactZoomPanPinchContentRef) => {
            currentScaleRef.current = ref.state.scale;
          }}
        >
          <TransformComponent
            wrapperStyle={{ width: '100%', height: '100%' }}
          >
            <div className="w-screen h-screen supports-[height:100dvh]:h-dvh flex items-center justify-center">
              {blurhashCache && currentImage.blurhash && (
                <BlurhashPlaceholder
                  hash={currentImage.blurhash}
                  width={currentImage.width}
                  height={currentImage.height}
                  cache={blurhashCache}
                  className="absolute inset-0"
                  objectFit="contain"
                />
              )}
              <div
                ref={imgContainerRef}
                className="max-w-full max-h-full relative z-10"
              />
            </div>
          </TransformComponent>
        </TransformWrapper>
      </div>

      {/* Left/Right buttons (desktop) */}
      <button
        onClick={goPrev}
        className="hidden sm:flex absolute left-2 top-1/2 -translate-y-1/2 z-20 p-2 text-white/60 hover:text-white transition-colors"
      >
        <ChevronLeft size={32} />
      </button>
      <button
        onClick={goNext}
        className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 z-20 p-2 text-white/60 hover:text-white transition-colors"
      >
        <ChevronRight size={32} />
      </button>

      {/* Top bar with gradient fade */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 transition-opacity duration-200 ${showUI ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <div className="bg-gradient-to-b from-black/70 via-black/50 to-transparent h-28" />
        <div className="relative -mt-26 flex items-center justify-between px-3 py-2">
          <button
            onClick={onClose}
            className="p-2 text-white/80 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
          <span className="text-white/80 text-sm truncate max-w-[60vw]" title={currentImage.name}>
            {currentImage.name} ({currentIndex + 1}/{images.length})
          </span>
          {showFileTreeButton && onOpenFileTree ? (
            <button
              onClick={onOpenFileTree}
              className="p-2 text-white/60 hover:text-white transition-colors"
            >
              <FolderTree size={20} />
            </button>
          ) : (
            <div className="w-8" />
          )}
        </div>
      </div>

      {/* Bottom thumbnail strip with gradient fade */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-200 ${showUI ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <div className="bg-gradient-to-t from-black/70 via-black/50 to-transparent h-32" />
        <div className="relative -mt-20 safe-bottom">
          <div
            ref={thumbStripRef}
            className="flex gap-1.5 px-3 py-2 overflow-x-auto scrollbar-hide"
          >
            {images.map((img, i) => (
              <button
                key={img.name}
                onClick={() => setCurrentIndex(i)}
                className={`shrink-0 w-10 h-10 rounded overflow-hidden transition-opacity relative ${
                  i === currentIndex ? 'opacity-100 ring-1 ring-white/60' : 'opacity-50'
                }`}
              >
                <div className="absolute inset-0 bg-gray-700" />
                <img
                  src={img.thumbUrl}
                  alt={img.name}
                  className="w-full h-full object-cover relative z-10"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
