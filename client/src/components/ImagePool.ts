/**
 * ImagePool — 图片预加载对象池
 *
 * 为 ImageViewer 提供图片预加载能力。维护一个 HTMLImageElement 对象池，
 * 切换当前图片时按 +1,+2,-1,+3,+4,-2,-3,+5,-4,-5 顺序预加载周围图片，
 * 再次切换时可直接从池中取出已加载的 img 元素挂载到 DOM，实现即时显示。
 *
 * ## 核心机制
 *
 * - **池 Map<number, PoolEntry>**：以图片索引为 key，每个条目持有 img 元素、加载状态、重试计数
 * - **加载队列**：queue[] + activeLoads Set，最多 3 个并发加载
 * - **淘汰**：距离当前索引 > ±10 的条目释放 img.src='' 并从池中移除
 * - **超时**：2s 超时不中断加载，只让出并发槽位（图片可能仍在加载，后续切换回来可直接使用）
 * - **重试**：当前图片加载失败且 retryCount < 2 → 重新入队头部；预加载失败不重试
 *
 * ## 切换流程 (setCurrent)
 *
 * 1. 淘汰远距离条目
 * 2. 清空未开始的队列任务（保留 activeLoads 中的进行中加载）
 * 3. 当前图片未 loaded → 加入队列头部
 * 4. 按预加载顺序追加（跳过已加载/加载中/越界）
 * 5. processQueue()
 *
 * ## React 集成
 *
 * 由 useImagePool hook 封装，通过 onStateChange 回调触发 React 重渲染。
 * hook 中用 useLayoutEffect 将 pooled img 挂载到 DOM，在浏览器 paint 前执行，
 * 防止切换到预加载图片时的空白帧闪烁。
 */

interface PoolEntry {
  img: HTMLImageElement;
  state: 'loading' | 'loaded' | 'failed';
  retryCount: number;
}

// 最大并发加载数
const MAX_CONCURRENT = 3;
// 超过此距离的条目会被淘汰并释放 img.src
const MAX_DISTANCE = 10;
// 加载超时（ms）：不中断加载，只让出并发槽位
const LOAD_TIMEOUT = 2000;
// 当前图片加载失败时的最大重试次数（预加载不重试）
const MAX_RETRY = 2;

// 预加载顺序：优先向前（+1,+2），次向后（-1），再向远处扩展
// 总共预加载 ±5 范围内的 10 张图片
const PRELOAD_OFFSETS = [1, 2, -1, 3, 4, -2, -3, 5, -4, -5];

export class ImagePool {
  private pool = new Map<number, PoolEntry>();
  private queue: number[] = [];
  private activeLoads = new Set<number>();
  private timeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private onStateChange: (index: number, state: PoolEntry['state']) => void;
  private getUrl: (index: number) => string;
  private length: number;
  private currentIndex = -1;

  constructor(
    length: number,
    getUrl: (index: number) => string,
    onStateChange: (index: number, state: PoolEntry['state']) => void,
  ) {
    this.length = length;
    this.getUrl = getUrl;
    this.onStateChange = onStateChange;
  }

  /** 切换当前索引，触发淘汰、入队、预加载 */
  setCurrent(index: number) {
    if (index === this.currentIndex) return;
    this.currentIndex = index;

    // 1. Evict distant entries
    this.evictDistant(index);

    // 2. Clear pending queue (keep active loads)
    this.queue = [];

    // 3. Current image: add to front if not loaded
    const currentEntry = this.pool.get(index);
    if (!currentEntry || currentEntry.state === 'failed') {
      // If failed and needs retry as current image
      if (currentEntry?.state === 'failed' && currentEntry.retryCount < MAX_RETRY) {
        this.pool.delete(index);
      }
      this.queue.unshift(index);
    }

    // 4. Build preload queue
    for (const offset of PRELOAD_OFFSETS) {
      const target = index + offset;
      if (target < 0 || target >= this.length) continue;
      const entry = this.pool.get(target);
      if (entry && (entry.state === 'loaded' || entry.state === 'loading')) continue;
      if (this.activeLoads.has(target)) continue;
      if (this.queue.includes(target)) continue;
      this.queue.push(target);
    }

    // 5. Process
    this.processQueue();
  }

  /** 获取指定索引的池条目（React hook 用于读取加载状态和 img 元素） */
  getEntry(index: number) {
    return this.pool.get(index);
  }

  /** 销毁池：清理定时器、释放 img.src、清空池 */
  destroy() {
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();
    this.queue = [];
    this.activeLoads.clear();
    for (const entry of this.pool.values()) {
      entry.img.src = '';
    }
    this.pool.clear();
  }

  private evictDistant(centerIndex: number): void {
    const toEvict: number[] = [];
    for (const [index] of this.pool) {
      if (Math.abs(index - centerIndex) > MAX_DISTANCE) {
        toEvict.push(index);
      }
    }
    for (const index of toEvict) {
      const entry = this.pool.get(index);
      if (entry) {
        entry.img.src = '';
        this.pool.delete(index);
      }
      // Remove from queue if pending
      const qi = this.queue.indexOf(index);
      if (qi !== -1) this.queue.splice(qi, 1);
    }
  }

  private processQueue(): void {
    while (this.activeLoads.size < MAX_CONCURRENT && this.queue.length > 0) {
      const index = this.queue.shift()!;
      this.startLoad(index);
    }
  }

  private startLoad(index: number): void {
    // Skip if already loaded or currently loading
    const existing = this.pool.get(index);
    if (existing?.state === 'loaded') return;
    if (this.activeLoads.has(index)) return;

    const img = existing?.img ?? new Image();
    img.className = 'max-w-full max-h-full object-contain select-none';
    img.draggable = false;
    img.alt = '';

    const entry: PoolEntry = {
      img,
      state: 'loading',
      retryCount: existing?.retryCount ?? 0,
    };
    this.pool.set(index, entry);
    this.activeLoads.add(index);

    // Timeout: don't abort, just free up concurrent slot
    const timer = setTimeout(() => {
      this.timeoutTimers.delete(index);
      if (this.activeLoads.has(index)) {
        this.activeLoads.delete(index);
        this.processQueue();
      }
    }, LOAD_TIMEOUT);
    this.timeoutTimers.set(index, timer);

    img.onload = () => {
      this.cleanupLoad(index);
      entry.state = 'loaded';
      this.onStateChange(index, 'loaded');
      this.processQueue();
    };

    img.onerror = () => {
      this.cleanupLoad(index);
      entry.state = 'failed';
      // Retry current image
      if (index === this.currentIndex && entry.retryCount < MAX_RETRY) {
        entry.retryCount++;
        this.pool.delete(index);
        this.queue.unshift(index);
        this.processQueue();
      }
      this.onStateChange(index, 'failed');
      this.processQueue();
    };

    img.src = this.getUrl(index);
  }

  private cleanupLoad(index: number): void {
    this.activeLoads.delete(index);
    const timer = this.timeoutTimers.get(index);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(index);
    }
  }
}
