/** Match password diagnostics, not listing metadata or filenames containing those words. */
export function isArchivePasswordError(message: string): boolean {
  return message.split(/\r?\n/).some(line => {
    const diagnostic = line.trim().replace(/^(?:Error:\s*)?(?:(?:无法检查压缩包内容|7z 解压失败):\s*)?(?:ERROR:\s*)?/i, '');
    return /^(?:此(?: ZIP)?\s*压缩包需要密码|密码错误)/i.test(diagnostic)
      || /^(?:Enter password(?: \(will not be echoed\))?:|(?:wrong|incorrect|required|missing) password\b|password (?:is )?required\b)/i.test(diagnostic)
      || / : (?:can not|cannot) open encrypted archive\. Wrong password\?$/i.test(diagnostic)
      || /^(?:(?:can not|cannot) open encrypted archive\b|(?:data error|headers error|crc failed) in encrypted (?:file|archive)\b)/i.test(diagnostic);
  });
}
