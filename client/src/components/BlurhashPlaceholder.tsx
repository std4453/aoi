import { useMemo } from 'react';
import { decode } from 'blurhash';

/**
 * Blurhash 占位图组件与工具函数
 *
 * ## 为什么用 `<div>` + `background-image` 而非 `<img>` + `object-fit`
 *
 * 在 ImageViewer 中，blurhash 占位图的容器尺寸取决于已加载图片的尺寸。
 * 使用 `<img>` 时，若原图未加载完成，浏览器无法确定容器尺寸，
 * 导致 `<img>` 元素渲染为 0×0，连带有实际尺寸的 blurhash 也无法显示。
 * 使用 `<div>` + `background-image` + `background-size` 可避免此问题，
 * 因为容器尺寸由 CSS 布局决定，不依赖内容。
 *
 * ## 缓存机制
 *
 * - `cache: Map<string, string>` 以 blurhash 字符串为 key，data URL 为 value
 * - 缓存由 PackDetailPage 持有（`useRef(new Map())`），页面卸载时释放
 * - PackDetailPage 在 useEffect 中遍历所有 thumbnails 预计算 data URL，
 *   避免 ImageViewer 切换时的解码延迟
 *
 * ## 解码分辨率
 *
 * 短边 32px，按原始宽高比计算长边。兼顾清晰度和性能：
 * 太小（如 8px）会导致模糊失真，太大（如 64px）会增加解码时间和 data URL 体积。
 */

export function blurhashToDataUrl(
  hash: string,
  width: number,
  height: number,
  cache: Map<string, string>,
): string | undefined {
  const cached = cache.get(hash);
  if (cached) return cached;

  try {
    // Decode at a small resolution maintaining aspect ratio
    const maxDim = 32;
    const scale = maxDim / Math.min(width, height);
    const decodeW = Math.max(1, Math.round(width * scale));
    const decodeH = Math.max(1, Math.round(height * scale));

    const pixels = decode(hash, decodeW, decodeH);
    const canvas = document.createElement('canvas');
    canvas.width = decodeW;
    canvas.height = decodeH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const imageData = ctx.createImageData(decodeW, decodeH);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);

    const dataUrl = canvas.toDataURL('image/png');
    cache.set(hash, dataUrl);
    return dataUrl;
  } catch {
    return undefined;
  }
}

interface BlurhashPlaceholderProps {
  hash: string | null | undefined;
  width?: number | null;
  height?: number | null;
  cache: Map<string, string>;
  className?: string;
  objectFit?: 'contain' | 'cover';
}

export default function BlurhashPlaceholder({ hash, width, height, cache, className, objectFit = 'cover' }: BlurhashPlaceholderProps) {
  const dataUrl = useMemo(() => {
    if (!hash || !width || !height) return undefined;
    return blurhashToDataUrl(hash, width, height, cache);
  }, [hash, width, height, cache]);

  if (!dataUrl) return null;

  return (
    <div
      className={className}
      style={{
        backgroundImage: `url(${dataUrl})`,
        backgroundSize: objectFit,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}
