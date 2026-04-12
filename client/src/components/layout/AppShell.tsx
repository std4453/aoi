import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Home, Upload, SlidersHorizontal, Settings } from 'lucide-react';
import { saveHomeScrollY, clearHomeScrollY } from '../../lib/homeScrollStore';

const navItems = [
  { to: '/', icon: Home, label: '图包' },
  { to: '/upload', icon: Upload, label: '上传' },
  { to: '/presets', icon: SlidersHorizontal, label: '预设' },
  { to: '/settings', icon: Settings, label: '设置' },
];

export default function AppShell() {
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col bg-gray-950">
      {/* Main content */}
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-4 pb-24">
        <Outlet />
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
                onClick={() => {
                  if (to === '/' && location.pathname === '/') {
                    clearHomeScrollY();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  } else if (location.pathname === '/') {
                    saveHomeScrollY();
                  }
                }}
                className={`flex-1 flex flex-col items-center py-2 gap-0.5 transition-colors ${
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
