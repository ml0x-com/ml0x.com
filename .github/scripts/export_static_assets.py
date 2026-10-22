"""Export immutable plain-static Git content and verify the exact deployment artifact."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
from render_worker_routes import generate

EXTENSIONS = {'.html', '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.svg', '.ico', '.jpg', '.jpeg', '.webp', '.png', '.gif', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.pdf', '.csv', '.tsv', '.wasm', '.webmanifest', '.mp3', '.mp4', '.webm', '.ogg', '.wav'}
METADATA_DIRS = {'test', 'tests', 'scripts', 'templates', 'node_modules', 'vendor'}
DOCS = {'readme.md', 'agents.md', 'claude.md', 'license.md', 'changelog.md', 'contributing.md', 'security.md'}
PRIVATE = {
    'private key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'GitHub token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b',
    'Porkbun key': rb'\b(?:pk1|sk1)_[A-Za-z0-9]{20,}\b',
    'AWS access key': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'Stripe secret': rb'\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b',
    'credential literal': rb'(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|PORKBUN_API_SECRET|secretapikey|password)\s*[=:]\s*[\"\'][^\"\'\n]{16,}[\"\']',
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def file_manifest(assets):
    rows = []
    for path in sorted(assets.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlink refused: ' + str(path))
        if path.is_file():
            rows.append({'path': path.relative_to(assets).as_posix(), 'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size})
    return rows

def digest(rows):
    return sha(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode())

def config(path, worker):
    value = json.loads(path.read_text())
    expected = {'name': worker, 'compatibility_date': '2026-10-22', 'workers_dev': True, 'assets': {'directory': '../_ssl_bundle/assets', 'html_handling': 'none', 'not_found_handling': '404-page'}}
    if value != expected:
        raise ValueError('Deployment config must remain assets-only, with no routes, domains, bindings or Worker code')
    return sha(path.read_bytes())

def export(output, worker, domain, cfg):
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    archive = subprocess.check_output(['git', 'archive', '--format=tar', commit])
    output.mkdir()
    assets = output / 'assets'
    assets.mkdir()
    excluded = []
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or any(ord(c) < 32 for c in str(path)) or not (member.isdir() or member.isfile()):
                raise ValueError('Unsafe Git archive entry')
            if member.isdir():
                continue
            if path.parts[0] in {'_config.yml', '_config.yaml', '_layouts', '_includes', '_posts', '_data', 'Gemfile', 'Gemfile.lock'}:
                raise ValueError('New Jekyll inputs require rendered-artifact review: ' + str(path))
            if any(part.startswith(('.', '_')) for part in path.parts) or path.parts[0] in METADATA_DIRS or path.name == 'generate.js':
                excluded.append(str(path))
                continue
            if path.name in {'Gemfile', 'Gemfile.lock'} or (path.suffix.lower() in {'.md', '.markdown', '.scss', '.sass'} and path.name.lower() not in DOCS):
                raise ValueError('New rendered-source format requires review: ' + str(path))
            if re.search(r'\.(?:php\d*|phtml|phar|pem|key)$', path.name, re.I):
                raise ValueError('Private or server-code file refused: ' + str(path))
            if path.suffix.lower() not in EXTENSIONS:
                excluded.append(str(path))
                continue
            data = tar.extractfile(member).read()
            if path.suffix.lower() in {'.html', '.css', '.xml', '.js'} and data.startswith((b'---\n', b'---\r\n')):
                raise ValueError('Jekyll frontmatter requires rendered-artifact review: ' + str(path))
            for kind, pattern in PRIVATE.items():
                if re.search(pattern, data, re.I if kind == 'credential literal' else 0):
                    raise ValueError(kind + ' signal in ' + str(path))
            target = assets.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    if not (assets / 'index.html').is_file() or not (assets / '404.html').is_file():
        raise ValueError('Static index.html and 404.html are required')
    runtime_count = sum(p.is_file() for p in assets.rglob('*'))
    routes, routing = generate(assets)
    (assets / '_redirects').write_text(routes)
    rows = file_manifest(assets)
    root = digest(rows)
    manifest = {'domain': domain, 'worker_name': worker, 'source_commit': commit, 'runtime_files': runtime_count, 'routing': routing, 'package_manifest_sha256': root, 'wrangler_config_sha256': config(cfg, worker), 'files': rows, 'excluded_paths': sorted(excluded)}
    (output / 'package-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    (output / 'root-manifest.sha256').write_text(root + '\n')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write('root_digest=' + root + '\n')
    print(json.dumps({'source_commit': commit, 'runtime_files': runtime_count, 'root_manifest_sha256': root, 'routing': routing}, sort_keys=True))

def verify(output, worker, domain, cfg, expected):
    manifest = json.loads((output / 'package-manifest.json').read_text())
    rows = file_manifest(output / 'assets')
    if manifest['files'] != rows or manifest['package_manifest_sha256'] != digest(rows) or expected != digest(rows):
        raise ValueError('Downloaded asset bytes or root manifest digest changed')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if manifest['source_commit'] != commit or manifest['worker_name'] != worker or manifest['domain'] != domain or manifest['wrangler_config_sha256'] != config(cfg, worker):
        raise ValueError('Artifact provenance or assets-only config changed')
    print(json.dumps({'verified_files': len(rows), 'source_commit': commit, 'root_manifest_sha256': expected}, sort_keys=True))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='_ssl_bundle', type=Path)
    parser.add_argument('--worker', required=True)
    parser.add_argument('--domain', required=True)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--expected-digest')
    args = parser.parse_args()
    cfg = Path('.cloudflare/wrangler.jsonc')
    if args.verify:
        if not args.expected_digest:
            parser.error('--verify requires --expected-digest')
        verify(args.output, args.worker, args.domain, cfg, args.expected_digest)
    else:
        export(args.output, args.worker, args.domain, cfg)
