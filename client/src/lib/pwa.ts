export function isPwa(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export async function registerPwa(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // Registrations can also control ordinary tabs sharing the app's origin.
  const mode = () => navigator.serviceWorker.controller?.postMessage({ type: 'pwa-mode', enabled: isPwa() });
  navigator.serviceWorker.addEventListener('controllerchange', mode);
  mode();
  if (!isPwa()) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })),
        new Promise<void>(resolve => setTimeout(resolve, 8000)),
      ]);
    }
    mode();
  } catch (error) {
    console.warn('离线缓存未能启用，继续在线使用', error);
  }
}
