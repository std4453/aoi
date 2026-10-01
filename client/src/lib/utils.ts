export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '---';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0)} ${sizes[i]}`;
}

export function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const statusLabels: Record<string, string> = {
  uploading: '上传中',
  extracting: '解压中',
  thumbnailing: '生成缩略图中',
  verifying: '校验中',
  awaiting_confirmation: '等待上传确认',
  extracted: '可预览',
  generating: '生成中',
  generated: '已生成',
  failed: '失败',
};

export const statusColors: Record<string, string> = {
  uploading: 'text-blue-400',
  extracting: 'text-yellow-400',
  thumbnailing: 'text-yellow-400',
  verifying: 'text-yellow-400',
  awaiting_confirmation: 'text-blue-400',
  extracted: 'text-green-400',
  generating: 'text-yellow-400',
  generated: 'text-green-400',
  failed: 'text-red-400',
};
