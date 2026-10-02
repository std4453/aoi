import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { apiFetch, resourceUrl } from '../lib/connection';
import type { UgoiraManifest } from '../../../shared/types';

// Playback updates the viewer's pooled image; sizing, blurhash and gestures stay shared.
export default function UgoiraPlayer({ url, image }: { url: string; image: HTMLImageElement | null }) {
  const [manifest, setManifest] = useState<UgoiraManifest | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const frame = useRef(0);
  useLayoutEffect(() => {
    if (!image) return;
    const poster = image.src;
    const onload = image.onload;
    const onerror = image.onerror;
    image.onload = null;
    image.onerror = null;
    return () => {
      image.src = poster;
      image.onload = onload;
      image.onerror = onerror;
    };
  }, [image]);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('无法读取动画');
      const data = await response.json() as UgoiraManifest;
      if (data.format !== 'aoi-ugoira' || data.version !== 1 || !data.frames.length) throw new Error('不支持的动画格式');
      setManifest(data);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [url]);
  useEffect(() => {
    if (!manifest || !playing || !image) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const loadFrame = (index: number) => {
      const nextImage = new Image();
      nextImage.crossOrigin = 'anonymous';
      nextImage.src = resourceUrl(`${url}?frame=${index}`);
      return nextImage.decode().then(() => nextImage);
    };
    let next = loadFrame(frame.current);
    const display = async () => {
      const index = frame.current;
      try {
        const nextImage = await next;
        if (disposed) return;
        image.src = nextImage.src;
        frame.current = (index + 1) % manifest.frames.length;
        next = loadFrame(frame.current);
        void next.catch(() => {});
        timer = setTimeout(() => void display(), manifest.frames[index].delay);
      } catch {
        if (!disposed) { setError('动画帧加载失败，请重试'); setPlaying(false); }
      }
    };
    void display();
    return () => { disposed = true; clearTimeout(timer); };
  }, [url, manifest, playing, image]);
  return <div className="flex flex-col items-center pointer-events-auto">
    <button type="button" disabled={!manifest || !image} onClick={() => { setError(''); setPlaying(value => !value); }}
      className="mt-3 flex items-center gap-2 rounded-full bg-gray-800/90 px-4 py-2 text-white text-sm disabled:opacity-50">
      {playing ? <Pause size={16} /> : <Play size={16} />}{playing ? '暂停动画' : '播放动画'}
    </button>
    {error && <p role="alert" className="text-red-300 text-xs mt-2">{error}</p>}
  </div>;
}
