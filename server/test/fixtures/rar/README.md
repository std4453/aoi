# RAR regression corpus

The small archives in `corpus.json` are fixed Base64 fixtures, with SHA-256 hashes
for both archive bytes and every extracted file. Tests decode them into isolated
temporary directories and remove those directories afterward. Tests do not fetch
fixtures, invoke RAR to create archives, or read application/user data.

| Fixture | Purpose |
| --- | --- |
| `rar4-compressed` | A real RAR4 m3 compressed block; catches missing legacy codecs |
| `rar5-compressed` | RAR5 m3 compression, Unicode and spaces, ordinary empty link fields |
| `rar5-solid` | Solid compression across multiple images |
| `rar5-password` | Content encryption without encrypted headers |
| `rar5-header-password` | Content and filename/header encryption with solid compression |

RAR5 fixtures contain three synthetic 32×32 PNG images and two harmless text
files named `RefreshToken.php` and `create_password_resets_table.php`. One image
is named `wrong password.png`. These names reproduce diagnostic classification
bugs without including application code or personal files. The PNG IDAT stream
is stored without DEFLATE compression so the RAR encoder actually uses m3 for
the image entries instead of silently storing every entry as m0.

RAR5 fixtures were created with RAR 7.23 for macOS ARM on October 3, 2026:

```sh
rar a -idq -m3 -md4m -mt1 -r -ts- -o+ -s- compressed.rar .
rar a -idq -m3 -md4m -mt1 -r -ts- -o+ -s solid.rar .
rar a -idq -m3 -md4m -mt1 -r -ts- -o+ -s- -paoi-rar-fixture password.rar .
rar a -idq -m3 -md4m -mt1 -r -ts- -o+ -s -hpaoi-rar-fixture header-password.rar .
```

`aoi-rar-fixture` is public test data, not a credential. Regenerating encrypted
archives changes their random salt; review and update archive hashes explicitly.
The pinned corpus is what makes normal runs repeatable.

The RAR4 fixture isolates the `testdir/test.txt` file header and compressed block
from libarchive's `test_read_format_rar_compress_normal.rar.uu`, retaining its
original main/end headers. The payload is exactly `test text document\r\n`.
Source revision: `7e9bfb0469afa0bb7362a56e79be87bedcb91946` in
`https://github.com/libarchive/libarchive`, under `libarchive/test/`.
See `LICENSE.libarchive` for the retained license. Other files and the original
fixture's symlink are omitted.

## Running and maintaining the baseline

```sh
sh scripts/install-7zip.sh /tmp/aoi-7zip
PATH=/tmp/aoi-7zip:$PATH npm run test:rar
PATH=/tmp/aoi-7zip:$PATH npm run check
```

The installer pins the official full 7-Zip 26.03 release and verifies its
published SHA-256 digest. A decoder missing Rar3/Rar5 codecs fails before any
archive is processed. `scripts/check-rar.mjs` then checks actual decompression
and every content hash; listing format support is never enough.

The API baseline exercises upload → extraction → thumbnails → generation →
ZIP download, duplicate confirmation, missing/wrong/correct passwords, restart
recovery, cancellation, damaged archives and error summaries. Existing generated
RAR4 tests cover plain image extraction and truncation; link-metadata tests ensure
empty RAR5 fields are permitted while real links remain rejected. Unsupported
methods and filenames containing password/login words must not request credentials.

CI runs `npm run test:rar` as a named check step and includes the suite in the
full `npm run check`. After building the final Docker image, CI runs the same
offline decoder/hash check inside that image before publishing it. Neither
missing tools nor unsupported codecs are skipped. Upgrade the installer and
corpus only with both checks passing; keep user's reproductions out of Git.
