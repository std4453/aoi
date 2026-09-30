import { serverWritable } from '../../lib/connection';
import { useRef, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Home, Upload, Settings } from 'lucide-react';
import { saveHomeScrollY, clearHomeScrollY, getLastHomeSearch, saveLastHomeSearch, triggerHomeReset } from '../../lib/homeStore';

const navItems = [
  { to: '/', icon: Home, label: '图包' },
  { to: '/upload', icon: Upload, label: '上传' },
  { to: '/settings', icon: Settings, label: '设置' },
];

export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const lastTabClickRef = useRef(0);

  useEffect(() => {
    if (location.pathname !== '/') {
      window.scrollTo(0, 0);
    }
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-950">
      {/* Main content */}
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-4 pb-24">
        {!serverWritable && <div role="status" className="mb-4 rounded-lg border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">只读备服务器 · 可浏览和下载，内容随同步更新</div>}
        {!serverWritable && location.pathname.replace(/\/+$/, '') === '/upload' ? <p className="text-gray-400">备服务器不支持上传，请连接主服务器。</p> : <Outlet />}
      </main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-gray-950/90 backdrop-blur-lg border-t border-gray-800 safe-bottom">
        <div className="max-w-4xl mx-auto flex">
          {navItems.map(({ to, icon: Icon, label }) => {
            const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
            return (
              <NavLink
                key={to}
                to={to}
                aria-disabled={!serverWritable && to === '/upload'}
                onClick={(e) => {
                  if (!serverWritable && to === '/upload') { e.preventDefault(); return; }
                  if (to === '/') {
                    if (location.pathname === '/') {
                      e.preventDefault();
                      const now = Date.now();
                      const isAtTop = window.scrollY < 10;
                      const isDoubleTap = now - lastTabClickRef.current < 300;
                      lastTabClickRef.current = now;

                      if (isAtTop || isDoubleTap) {
                        triggerHomeReset();
                      } else {
                        clearHomeScrollY();
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }
                    } else {
                      const savedSearch = getLastHomeSearch();
                      if (savedSearch) {
                        e.preventDefault();
                        navigate(`/${savedSearch}`);
                      }
                    }
                  } else if (location.pathname === '/') {
                    saveHomeScrollY();
                    saveLastHomeSearch(window.location.search);
                  }
                }}
                className={`${!serverWritable && to === '/upload' ? 'opacity-40 cursor-not-allowed' : ''} flex-1 flex flex-col items-center py-2 gap-0.5 transition-colors ${
                  isActive ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <Icon size={22} />
                <span className="text-xs">{label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
