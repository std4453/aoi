import type { PixivSettings as Settings } from '../../../shared/types';
import { fetchPixivSettings, updatePixivSettings } from '../api/pixiv';
import { getBrowserLogin, startBrowserLogin, completeBrowserLogin, cancelBrowserLogin } from '../api/browser-login';
import { PixivIcon } from './ImportSources';
import ExternalLoginSettings, { type LoginSettingsAdapter, type LoginSettingsProps, type LoginSettingsState } from './ExternalLoginSettings';
import loginPreview from '../assets/pixiv-login.png';

const state = (settings: Settings): LoginSettingsState => ({
  configured: settings.configured, browserLoginEnabled: settings.browserLoginEnabled,
  credential: settings.refreshToken ?? '',
});
const adapter: LoginSettingsAdapter = {
  name: 'Pixiv', icon: <PixivIcon className="h-6 w-6" />, preview: loginPreview,
  sessionInstructions: '完成 Pixiv 官方登录后将自动保存并关闭窗口。如未自动完成，可点击「我已登录」。',
  loginSuccess: 'Pixiv 登录成功', saveSuccess: 'Pixiv 登录配置已保存',
  credentialLabel: 'Refresh token', credentialPlaceholder: '粘贴 refresh token',
  instructions: <p className="mt-2 text-xs leading-5 text-gray-500">使用 <code>gallery-dl oauth:pixiv</code> 获取，仅保存在当前服务器。</p>,
  load: async () => state(await fetchPixivSettings(true)),
  save: async credential => state(await updatePixivSettings(credential)),
  browser: {
    get: () => getBrowserLogin('pixiv'),
    start: mobile => startBrowserLogin('pixiv', mobile),
    complete: id => completeBrowserLogin('pixiv', id),
    cancel: id => cancelBrowserLogin('pixiv', id),
  },
};

export default function PixivSettings(props: LoginSettingsProps) {
  return <ExternalLoginSettings {...props} adapter={adapter} />;
}
