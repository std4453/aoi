import type { FanboxSettings as Settings } from '../../../shared/types';
import { fetchFanboxSettings, updateFanboxSettings } from '../api/fanbox';
import { getBrowserLogin, startBrowserLogin, completeBrowserLogin, cancelBrowserLogin } from '../api/browser-login';
import { FanboxIcon } from './ImportSources';
import ExternalLoginSettings, { type LoginSettingsAdapter, type LoginSettingsProps, type LoginSettingsState } from './ExternalLoginSettings';
import loginPreview from '../assets/pixiv-login.png';

const state = (settings: Settings): LoginSettingsState => ({
  configured: settings.configured, browserLoginEnabled: settings.browserLoginEnabled,
  credential: settings.sessionId ?? '',
  readOnly: settings.source === 'cookie_file',
});
const adapter: LoginSettingsAdapter = {
  name: 'FANBOX', icon: <FanboxIcon className="h-6 w-6" />, preview: loginPreview,
  sessionInstructions: '完成 FANBOX 官方登录后将自动保存并关闭窗口。如未自动完成，可点击「我已登录」。',
  loginSuccess: 'FANBOX 登录成功', saveSuccess: 'FANBOX 登录配置已保存',
  credentialLabel: 'FANBOXSESSID', credentialPlaceholder: '粘贴 FANBOXSESSID 的值',
  readOnlyMessage: '登录态由服务端 Cookie 文件管理，请更新该文件。',
  instructions: <>
    <p className="mt-2 text-xs leading-5 text-gray-500">在已登录 FANBOX 的浏览器中，打开开发者工具 → Application / 存储 → Cookies，复制 FANBOXSESSID 的值。</p>
    <p className="mt-2 text-xs leading-5 text-gray-500">会话失效后需要重新登录；付费帖子需要相应访问权限。</p>
  </>,
  load: async () => state(await fetchFanboxSettings(true)),
  save: async credential => state(await updateFanboxSettings(credential)),
  browser: {
    get: () => getBrowserLogin('fanbox'),
    start: mobile => startBrowserLogin('fanbox', mobile),
    complete: id => completeBrowserLogin('fanbox', id),
    cancel: id => cancelBrowserLogin('fanbox', id),
  },
};

export default function FanboxSettings(props: LoginSettingsProps) {
  return <ExternalLoginSettings {...props} adapter={adapter} />;
}
