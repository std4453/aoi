import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import AppShell from './components/layout/AppShell';

const HomePage = lazy(() => import('./pages/HomePage'));
const UploadPage = lazy(() => import('./pages/UploadPage'));
const PackDetailPage = lazy(() => import('./pages/PackDetailPage'));
const PresetsPage = lazy(() => import('./pages/PresetsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const TagManagerPage = lazy(() => import('./pages/TagManagerPage'));

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full min-h-screen">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="packs/:id" element={<PackDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/tags" element={<TagManagerPage />} />
          <Route path="settings/presets" element={<PresetsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
