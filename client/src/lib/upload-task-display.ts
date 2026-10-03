import type { UploadTask } from '../../../shared/types';

/** Keep implementation diagnostics out of cards, including previously saved errors. */
export function taskFailureLabel(task: UploadTask): string {
  const error = task.error ?? '';
  if (/缩略图|thumbnail/i.test(error)) return '预览生成失败';
  if (/校验|verification|checksum/i.test(error)) return '校验失败';
  if (/解压|压缩包内容|not archive|as \[\w+\] archive|central directory|end of (?:file|data)/i.test(error)) return '解压失败';
  if (!task.packId) return task.source === 'archive' || task.source === 'folder' ? '上传失败' : '下载失败';
  return '处理失败';
}

export function taskErrorMessage(task: UploadTask): string {
  const error = task.error ?? '';
  if (/密码错误|wrong password|incorrect password/i.test(error)) return '密码不正确，请检查后重试。';
  if (task.status === 'password') return task.passwordKind === 'share'
    ? '此分享需要密码或解密密钥，请填写后继续。'
    : '此压缩包需要密码，请填写后继续。';
  if (/not archive|as \[\w+\] archive|central directory|end of (?:file|data)|压缩包已损坏/i.test(error)) return '压缩包已损坏或格式不正确，请检查文件后重新上传。';
  if (/ENOSPC|空间不足|no space/i.test(error)) return '存储空间不足，请释放空间后重试。';
  if (/登录|refresh.?token|unauthorized|authentication/i.test(error)) return '来源登录配置不可用，请检查配置后重试。';
  if (/quota|配额|流量限制/i.test(error)) return '来源服务的下载额度不足，请稍后重试。';
  if (/timeout|timed out|超时|fetch failed|ECONN|ENOTFOUND|network/i.test(error)) return '连接失败或超时，请检查网络及代理配置后重试。';
  if (/link.*(?:invalid|unavailable)|分享.*(?:失效|不存在)|not found|ENOENT/i.test(error)) return '文件或分享已不可用，请检查后重新上传或导入。';
  if (/exceeds|limit|超过|超出/i.test(error)) return '文件超出处理限制，请检查大小或文件数量后重试。';
  if (taskFailureLabel(task) === '解压失败') return '无法解压此图包，请检查压缩包是否完整后重试。';
  return '任务未能完成，请重试；如仍失败，请检查源文件或分享链接。';
}
