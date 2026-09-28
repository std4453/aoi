export async function registerPwa(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })),
        new Promise<void>(resolve => setTimeout(resolve, 8000)),
      ]);
    }
  } catch (error) {
    console.warn('离线缓存未能启用，继续在线使用', error);
  }
}
