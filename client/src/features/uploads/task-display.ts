import type { UploadTask } from '../../../../shared/types';
import { formatBytes } from '../../lib/utils';

export type TaskTone = 'neutral' | 'warning' | 'success' | 'error';

/** One status contract for card content, summary and notifications, across all sources. */
export const taskStates = {
  uploading: { label: '上传中', tone: 'neutral', content: 'transfer' },
  downloading: { label: '下载中', tone: 'neutral', content: 'transfer' },
  paused: { label: '已暂停', tone: 'neutral', content: 'transfer' },
  processing: { label: '处理中', tone: 'neutral', content: 'processing' },
  needs_file: { label: '待选择文件', tone: 'warning', content: 'attention' },
  password: { label: '待输入密码', tone: 'warning', content: 'attention' },
  duplicate: { label: '待确认重复', tone: 'warning', content: 'attention' },
  completed: { label: '已完成', tone: 'success', content: 'result' },
  failed: { label: '失败', tone: 'error', content: 'attention' },
} as const satisfies Record<UploadTask['status'], { label: string; tone: TaskTone; content: 'transfer' | 'processing' | 'attention' | 'result' }>;

export function taskNoticeMessage(task: UploadTask): string | undefined {
  if (taskStates[task.status].content !== 'attention') return;
  if (task.error || task.status === 'password' || task.status === 'failed') return taskErrorMessage(task);
  if (task.status === 'duplicate') return '此图包可能已被上传过，请确认是否继续。';
  if (task.status === 'needs_file') return `刷新后需重新选择原来的${task.source === 'folder' ? '文件夹' : '压缩包'}以继续上传。已上传的内容会保留。`;
}

export function taskProgressDisplay(task: UploadTask): { label: string; detail?: string; percentage?: number } {
  const percentage = Number.isFinite(task.progress) ? Math.max(0, Math.min(100, Math.round(task.progress))) : undefined;
  if (task.status === 'processing') {
    const processing = task.processing;
    if (!processing || processing.stage === 'preparing') return { label: '准备中' };
    const labels = { extracting: '解包中', verifying: '校验中', thumbnailing: '生成预览中' };
    const label = labels[processing.stage];
    // Queueing remains a real server state, but shares the stage's presentation.
    if (processing.queued || processing.total <= 0) return { label };
    const detail = processing.stage === 'verifying'
      ? `已校验 ${formatBytes(processing.completed)} / ${formatBytes(processing.total)}`
      : `${processing.completed} / ${processing.total} 个文件`;
    return { label, detail, percentage };
  }
  return {
    label: task.status === 'paused' ? '已暂停' : task.source === 'pixiv' || task.source === 'mega' || task.source === 'fanbox' ? '下载中' : '上传中',
    detail: task.totalBytes > 0 ? `${formatBytes(task.transferredBytes)} / ${formatBytes(task.totalBytes)}` : undefined,
    percentage: task.totalBytes > 0 ? percentage : undefined,
  };
}

/** Authentication and entitlement failures need user attention; network failures do not. */
export function taskNeedsLogin(task: UploadTask): boolean {
  if (task.status !== 'failed' || !['pixiv', 'fanbox'].includes(task.source)) return false;
  return /登录(?:失败|已失效|态|或验证|配置)|更新.*refresh.?token|未配置.*refresh.?token|不可访问|拒绝.*访问|无权|赞助/i.test(task.error ?? '') &&
    !/无法连接|网络|代理|超时|过于频繁/.test(task.error ?? '');
}

/** Keep implementation diagnostics out of cards, including previously saved errors. */
export function taskFailureLabel(task: UploadTask): string {
  const error = task.error ?? '';
  if (taskNeedsLogin(task)) return '需要登录';
  if (/解压|压缩包内容|not archive|as \[\w+\] archive|central directory|end of (?:file|data)|unsupported method/i.test(error)) return '解压失败';
  if (/缩略图|thumbnail/i.test(error)) return '预览生成失败';
  if (/校验|verification|checksum/i.test(error)) return '校验失败';
  if (!task.packId) return task.source === 'archive' || task.source === 'folder' ? '上传失败' : '下载失败';
  return '处理失败';
}

export function taskErrorMessage(task: UploadTask): string {
  const error = task.error ?? '';
  // Command output includes filenames (e.g. RefreshToken.php). Resolve extraction
  // failures before searching for remote-service errors in those diagnostics.
  if (/unsupported method|不支持.*压缩方法/i.test(error)) return '服务器解压工具不支持此压缩方法，请安装支持该格式的完整解压工具后重试。';
  if (/^(?:Error:\s*)?(?:密码错误|wrong password|incorrect password)/i.test(error)) return '密码不正确，请检查后重试。';
  if (task.status === 'password') return task.passwordKind === 'share'
    ? '此分享需要密码或解密密钥，请填写后继续。'
    : '此压缩包需要密码，请填写后继续。';
  if (/not archive|as \[\w+\] archive|central directory|end of (?:file|data)|压缩包已损坏/i.test(error)) return '压缩包已损坏或格式不正确，请检查文件后重新上传。';
  if (/ENOSPC|空间不足|no space/i.test(error)) return '存储空间不足，请释放空间后重试。';
  if (taskFailureLabel(task) === '解压失败') return '无法解压此图包，请检查压缩包是否完整后重试。';
  if (task.source === 'fanbox' && /没有可导入/.test(error)) return '帖子中没有支持的图片或视频，文字、压缩包及外部嵌入链接会被跳过。';
  if (task.source === 'fanbox' && /FlareSolverr|FANBOX 验证正在进行/.test(error)) return 'FANBOX 验证未完成，请稍后重试。';
  if (task.source === 'fanbox' && /拦截了服务器请求/.test(error)) return 'FANBOX 拦截了服务器请求，请稍后重试。';
  if (task.source === 'fanbox' && /不可访问|无权|赞助/.test(error)) return 'FANBOX 帖子不可访问。';
  if (/登录|refresh.?token|unauthorized|authentication/i.test(error)) return '来源登录配置不可用，请检查配置后重试。';
  if (/quota|配额|流量限制/i.test(error)) return '来源服务的下载额度不足，请稍后重试。';
  if (/timeout|timed out|超时|fetch failed|ECONN|ENOTFOUND|network/i.test(error)) return '连接失败或超时，请检查网络及代理配置后重试。';
  if (/link.*(?:invalid|unavailable)|分享.*(?:失效|不存在)|not found|ENOENT/i.test(error)) return '文件或分享已不可用，请检查后重新上传或导入。';
  if (/exceeds|limit|超过|超出/i.test(error)) return '文件超出处理限制，请检查大小或文件数量后重试。';
  return '任务未能完成，请重试；如仍失败，请检查源文件或分享链接。';
}
