"""Small, version-checked supplement to the official image; no browser profile is added."""
from pathlib import Path


def replace(source, before, after):
    if before not in source:
        raise RuntimeError('FlareSolverr source changed; review the local supplement')
    return source.replace(before, after)


utils = Path('/app/utils.py')
source = utils.read_text()
for flag in ['--no-sandbox', '--disable-setuid-sandbox', '--no-zygote',
             '--disable-gpu-sandbox', '--ignore-certificate-errors', '--ignore-ssl-errors']:
    source = replace(source, f"options.add_argument('{flag}')", 'pass  # Keep browser security enabled')
source = replace(source, 'options.add_argument("--disable-features=LocalNetworkAccessChecks")',
                 'pass  # Keep local network checks enabled')
source = replace(source, 'driver = uc.Chrome(options=options,',
                 'driver = uc.Chrome(options=options, no_sandbox=False,')
utils.write_text(source)

driver = Path('/app/undetected_chromedriver/__init__.py')
driver.write_text(replace(driver.read_text(), 'options.add_argument("--no-sandbox")',
                          'pass  # Keep sandbox enabled'))

service = Path('/app/flaresolverr_service.py')
source = service.read_text()
source = replace(source, '    # navigate to the page\n', '''    # FANBOX rejects direct API navigation without its web origin headers.
    # Scope the supplement to the same metadata endpoint accepted by AoI.
    if re.fullmatch(r"https://api\\.fanbox\\.cc/post\\.info\\?postId=[1-9]\\d{0,19}", req.url):
        driver.execute_cdp_cmd("Network.enable", {})
        driver.execute_cdp_cmd("Network.setExtraHTTPHeaders", {"headers": {
            "Origin": "https://www.fanbox.cc", "Referer": "https://www.fanbox.cc/",
            "Accept": "application/json"
        }})
        driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": [
            "*://downloads.fanbox.cc/*", "*://fanbox.pixiv.net/*",
            "*.png*", "*.jpg*", "*.jpeg*", "*.gif*", "*.webp*", "*.avif*",
            "*.mp4*", "*.webm*", "*.mp3*", "*.woff*", "*.ttf*"
        ]})

    # navigate to the page
''')
service.write_text('import re\n' + source)
