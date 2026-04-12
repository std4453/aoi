import { useRef, useState, useEffect } from 'react';
import { ImagePool } from '../components/ImagePool';

/**
 * useImagePool — ImagePool 的 React hook 封装
 *
 * 将 ImagePool 类与 React 生命周期集成，为 ImageViewer 提供：
 * - `currentImg`：当前索引对应的已加载 HTMLImageElement（用于 DOM 挂载）
 * - `imageLoaded`：当前图片是否已加载完成
 * - `wasAlreadyLoaded`：切换到此索引时图片是否已在池中加载完成（决定是否播放渐入动画）
 *
 * ## 关键设计
 *
 * - **imagesRef 模式**：images 通过 ref 传递给 pool 的 getUrl 回调，
 *   避免 images 变化导致 pool 重建（pool 在 mount 时创建一次，unmount 时销毁）
 * - **同步 wasAlreadyLoaded 检测**：在渲染函数体中（非 useEffect）检测 index 变化，
 *   同步读取 pool 状态。若放在 useEffect 中会有一个渲染帧的延迟，
 *   导致已预加载图片误触渐入动画
 * - **onStateChange 回调**：通过 setRevision 强制重渲染，使组件能响应池中状态变化
 */

interface ImageItem {
  fullUrl: string;
}

interface UseImagePoolResult {
  currentImg: HTMLImageElement | null;
  imageLoaded: boolean;
  wasAlreadyLoaded: boolean;
}

export function useImagePool(images: ImageItem[], currentIndex: number): UseImagePoolResult {
  const [, setRevision] = useState(0);
  const poolRef = useRef<ImagePool | null>(null);
  const prevIndexRef = useRef(-1);
  const wasAlreadyLoadedRef = useRef(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  // Create pool once; update getUrl callback when images change
  useEffect(() => {
    const pool = new ImagePool(
      imagesRef.current.length,
      (index: number) => imagesRef.current[index]?.fullUrl ?? '',
      () => setRevision((r) => r + 1),
    );
    poolRef.current = pool;
    return () => {
      pool.destroy();
      poolRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- imagesRef handles staleness

  // Update current index
  useEffect(() => {
    poolRef.current?.setCurrent(currentIndex);
  }, [currentIndex]);

  // Synchronously detect whether the image was already loaded when index changed
  if (prevIndexRef.current !== currentIndex) {
    const pool = poolRef.current;
    wasAlreadyLoadedRef.current = pool?.getEntry(currentIndex)?.state === 'loaded';
    prevIndexRef.current = currentIndex;
  }

  const pool = poolRef.current;
  const entry = pool?.getEntry(currentIndex);
  const imageLoaded = entry?.state === 'loaded';
  const currentImg = imageLoaded ? entry.img : null;

  return { currentImg, imageLoaded, wasAlreadyLoaded: wasAlreadyLoadedRef.current };
}
