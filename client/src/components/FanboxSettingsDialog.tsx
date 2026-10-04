import type { FanboxSettings as Settings } from '../../../shared/types';
import { fetchFanboxSettings, updateFanboxSettings } from '../api/fanbox';
import { getBrowserLogin, startBrowserLogin, completeBrowserLogin, cancelBrowserLogin } from '../api/browser-login';
import { FanboxIcon } from './ImportSources';
import { FormField, TextInput } from './Form';
import { browserLoginCopy } from './BrowserLogin';
import ExternalSettingsDialog, { externalSettingsCopy, type ExternalSettingsConfig, type SettingsDialogProps, type SettingsFormProps, type LoginSettingsState } from './ExternalSettingsDialog';
import loginPreview from '../assets/pixiv-login.png';

function FanboxSettingsForm({ value, onChange, disabled, readOnly }: SettingsFormProps) {
  if (readOnly) return <p className="text-sm text-gray-400">登录态由服务端 Cookie 文件管理，请更新该文件。</p>;
  return <>
    <FormField label="FANBOXSESSID">
      <TextInput type="text" autoComplete="off" spellCheck={false} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} maxLength={8192}
        placeholder="粘贴 FANBOXSESSID 的值" />
    </FormField>
    <p className="mt-2 text-xs leading-5 text-gray-500">在已登录 FANBOX 的浏览器中，打开开发者工具 → Application / 存储 → Cookies，复制 FANBOXSESSID 的值。</p>
    <p className="mt-2 text-xs leading-5 text-gray-500">会话失效后需要重新登录；付费帖子需要相应访问权限。</p>
  </>;
}

const state = (settings: Settings): LoginSettingsState => ({
  configured: settings.configured, browserLoginEnabled: settings.browserLoginEnabled,
  credential: settings.sessionId ?? '',
  readOnly: settings.source === 'cookie_file',
});
const configuration: ExternalSettingsConfig = {
  copy: {
    ...externalSettingsCopy, title: 'FANBOX 配置', loginSuccess: 'FANBOX 登录成功', saveSuccess: 'FANBOX 登录配置已保存',
    browser: { ...browserLoginCopy,
      instructions: '完成 FANBOX 官方登录后将自动保存并关闭窗口。如未自动完成，可点击「我已登录」。',
    },
  },
  icon: <FanboxIcon className="h-6 w-6" />,
  preview: <img src={loginPreview} alt="官方登录页面预览" className="mr-3 h-36 w-28 shrink-0 rounded-lg border border-white/10 object-cover object-top shadow-lg sm:w-36" />,
  Form: FanboxSettingsForm,
  load: async () => state(await fetchFanboxSettings(true)),
  save: async credential => state(await updateFanboxSettings(credential)),
  browser: {
    get: () => getBrowserLogin('fanbox'),
    start: mobile => startBrowserLogin('fanbox', mobile),
    complete: id => completeBrowserLogin('fanbox', id),
    cancel: id => cancelBrowserLogin('fanbox', id),
  },
};

export default function FanboxSettingsDialog(props: SettingsDialogProps) {
  return <ExternalSettingsDialog {...configuration} {...props} />;
}
