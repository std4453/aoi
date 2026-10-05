import assert from 'node:assert/strict';
import test from 'node:test';
import { isArchivePasswordError } from '~/services/archive-errors';

test('only explicit password diagnostics request archive credentials', () => {
  for (const message of [
    'Enter password:',
    'Enter password (will not be echoed):',
    'ERROR: Wrong password : image.png',
    'ERROR: Data Error in encrypted file. Wrong password? : image.png',
    'ERROR: CRC Failed in encrypted file. Wrong password? : image.png',
    'Headers Error in encrypted archive. Wrong password?',
    'ERROR: Can not open encrypted archive. Wrong password?',
    'ERROR: /tmp/original.rar : Cannot open encrypted archive. Wrong password?',
    '此 ZIP 压缩包需要密码，请在上传任务中填写密码后继续',
    '此压缩包需要密码，请在上传任务中填写密码后继续',
    'Error: 密码错误或压缩包已损坏',
    '7z 解压失败: ERROR: Wrong password',
  ]) assert.equal(isArchivePasswordError(message), true, message);
});

test('encryption metadata and filenames do not hide unrelated archive failures', () => {
  for (const message of [
    'ERROR: Unexpected end of archive\nPath = image.png\nEncrypted = -',
    'ERROR: Unsupported Method : image.png\nEncrypted = +',
    'Path = password.png\nEncrypted = -\nERROR: Headers Error',
    'ERROR: CRC Failed : encrypted-image.png',
    'ERROR: Unsupported Method : create_password_resets_table.php',
    'Extracting archive: /tmp/wrong password.rar\nERROR: Data Error',
    'Path = Wrong password.png',
    '系统中未找到 7z 命令，无法解压密码保护的压缩包',
  ]) assert.equal(isArchivePasswordError(message), false, message);
});
