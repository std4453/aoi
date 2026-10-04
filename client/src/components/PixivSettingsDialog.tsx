import type { PixivSettings as Settings } from '../../../shared/types';
import { fetchPixivSettings, updatePixivSettings } from '../api/pixiv';
import { getBrowserLogin, startBrowserLogin, completeBrowserLogin, cancelBrowserLogin } from '../api/browser-login';
import { PixivIcon } from './ImportSources';
import { FormField, TextInput } from './Form';
import { browserLoginCopy } from './BrowserLogin';
import ExternalSettingsDialog, { externalSettingsCopy, type ExternalSettingsConfig, type SettingsDialogProps, type SettingsFormProps, type LoginSettingsState } from './ExternalSettingsDialog';
import loginPreview from '../assets/pixiv-login.png';

function PixivSettingsForm({ value, onChange, disabled }: SettingsFormProps) {
  return <>
    <FormField label="Refresh token">
      <TextInput type="text" autoComplete="off" spellCheck={false} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} maxLength={8192}
        placeholder="粘贴 refresh token" />
    </FormField>
    <p className="mt-2 text-xs leading-5 text-gray-500">使用 <code>gallery-dl oauth:pixiv</code> 获取，仅保存在当前服务器。</p>
  </>;
}

const state = (settings: Settings): LoginSettingsState => ({
  configured: settings.configured, browserLoginEnabled: settings.browserLoginEnabled,
  credential: settings.refreshToken ?? '',
});
const configuration: ExternalSettingsConfig = {
  copy: {
    ...externalSettingsCopy, title: 'Pixiv 配置', loginSuccess: 'Pixiv 登录成功', saveSuccess: 'Pixiv 登录配置已保存',
    browser: { ...browserLoginCopy,
      instructions: '完成 Pixiv 官方登录后将自动保存并关闭窗口。如未自动完成，可点击「我已登录」。',
    },
  },
  icon: <PixivIcon className="h-6 w-6" />,
  preview: <img src={loginPreview} alt="官方登录页面预览" className="mr-3 h-36 w-28 shrink-0 rounded-lg border border-white/10 object-cover object-top shadow-lg sm:w-36" />,
  Form: PixivSettingsForm,
  load: async () => state(await fetchPixivSettings(true)),
  save: async credential => state(await updatePixivSettings(credential)),
  browser: {
    get: () => getBrowserLogin('pixiv'),
    start: mobile => startBrowserLogin('pixiv', mobile),
    complete: id => completeBrowserLogin('pixiv', id),
    cancel: id => cancelBrowserLogin('pixiv', id),
  },
};

export default function PixivSettingsDialog(props: SettingsDialogProps) {
  return <ExternalSettingsDialog {...configuration} {...props} />;
}
