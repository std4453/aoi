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
    label: task.status === 'paused' ? '已暂停' : task.isRemote ? '下载中' : '上传中',
    detail: task.totalBytes > 0 ? `${formatBytes(task.transferredBytes)} / ${formatBytes(task.totalBytes)}` : undefined,
    percentage: task.totalBytes > 0 ? percentage : undefined,
  };
}

/** The service decides whether credentials or permissions need user attention. */
export function taskNeedsLogin(task: UploadTask): boolean {
  return task.status === 'failed' && (task.source === 'pixiv' || task.source === 'fanbox') &&
    (task.errorCategory === 'authentication' || task.errorCategory === 'access');
}

export function taskFailureLabel(task: UploadTask): string {
  if (taskNeedsLogin(task)) return '需要登录';
  const labels = { extraction: '解压失败', preview: '预览生成失败', verification: '校验失败',
    upload: '上传失败', download: '下载失败' };
  if (task.errorCategory && task.errorCategory in labels) return labels[task.errorCategory as keyof typeof labels];
  return !task.packId ? task.isRemote ? '下载失败' : '上传失败' : '处理失败';
}

const errorMessages: Partial<Record<NonNullable<UploadTask['errorCode']>, string>> = {
  ARCHIVE_UNSUPPORTED: '服务器解压工具不支持此压缩方法，请安装支持该格式的完整解压工具后重试。',
  PASSWORD_INCORRECT: '密码不正确，请检查后重试。',
  ARCHIVE_INVALID: '压缩包已损坏或格式不正确，请检查文件后重新上传。',
  STORAGE_FULL: '存储空间不足，请释放空间后重试。',
  EXTRACTION_FAILED: '无法解压此图包，请检查压缩包是否完整后重试。',
  NO_SUPPORTED_MEDIA: '帖子中没有支持的图片或视频，文字、压缩包及外部嵌入链接会被跳过。',
  CHALLENGE_FAILED: 'FANBOX 验证未完成，请稍后重试。',
  SOURCE_BLOCKED: 'FANBOX 拦截了服务器请求，请稍后重试。',
  AUTH_REQUIRED: '来源登录配置不可用，请检查配置后重试。',
  ACCESS_DENIED: '来源内容不可访问，请检查登录配置及访问权限。',
  SOURCE_QUOTA: '来源服务的下载额度不足，请稍后重试。',
  NETWORK_ERROR: '连接失败或超时，请检查网络及代理配置后重试。',
  RATE_LIMITED: '来源服务请求过于频繁，请稍后重试。',
  SOURCE_UNAVAILABLE: '文件或分享已不可用，请检查后重新上传或导入。',
  RESOURCE_LIMIT: '文件超出处理限制，请检查大小或文件数量后重试。',
};

export function taskErrorMessage(task: UploadTask): string {
  if (task.errorCode === 'PASSWORD_INCORRECT') return errorMessages.PASSWORD_INCORRECT!;
  if (task.status === 'password') return task.passwordKind === 'share'
    ? '此分享需要密码或解密密钥，请填写后继续。'
    : '此压缩包需要密码，请填写后继续。';
  if (task.source === 'fanbox' && task.errorCode === 'ACCESS_DENIED') return 'FANBOX 帖子不可访问。';
  return task.errorCode && errorMessages[task.errorCode] || '任务未能完成，请重试；如仍失败，请检查源文件或分享链接。';
}
