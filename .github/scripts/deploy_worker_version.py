"""Deploy only the uploaded, attested assets-only version using one Worker Editor token."""
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request
from export_static_assets import verify

UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def request(account, worker, token, suffix, payload=None):
    url = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/' + worker + suffix
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='GET' if payload is None else 'POST')
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError('Worker API request failed with HTTP ' + str(error.code)) from None
    if value.get('success') is not True or 'result' not in value:
        raise RuntimeError('Worker API request did not report success')
    return value['result']


def attest(version, version_id, tag, commit, root, bundle):
    if version.get('id') != version_id:
        raise ValueError('Version ID differs from the successful upload')
    annotations = version.get('annotations', {})
    if annotations.get('workers/tag') != tag or annotations.get('workers/message') != commit + ' ' + root:
        raise ValueError('Version source commit, artifact digest or unique CI tag differs')
    resources = version.get('resources', {})
    if resources.get('bindings') != [] or resources.get('script', {}).get('handlers') not in (None, []) or resources.get('script', {}).get('etag') != '':
        raise ValueError('Uploaded version must have no bindings or Worker code')
    runtime = resources.get('script_runtime', {})
    if runtime.get('compatibility_date') != '2026-10-22':
        raise ValueError('Unexpected compatibility date')
    assets = runtime.get('assets', {})
    if assets.get('html_handling') != 'none' or assets.get('not_found_handling') != '404-page' or assets.get('serve_directly') is not True or assets.get('raw_run_worker_first') is not False or assets.get('base_path') != '/':
        raise ValueError('Uploaded version does not preserve the assets-only routing policy')
    if assets.get('raw_redirects') != (bundle / 'assets/_redirects').read_text():
        raise ValueError('Uploaded version routing differs from the verified artifact')
    if assets.get('raw_headers') or assets.get('headers'):
        raise ValueError('Unexpected asset header overrides')
    rules = assets.get('redirects', {})
    expected = {}
    for number, line in enumerate((bundle / 'assets/_redirects').read_text().splitlines(), 1):
        source, target, status = line.split()
        expected[source] = {'to': target, 'status': int(status), 'lineNumber': number}
    if rules.get('version') != 1 or rules.get('rules') != {} or rules.get('staticRules') != expected:
        raise ValueError('Remote compiled routing differs from the verified artifact')


def main():
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    token = os.environ['CLOUDFLARE_API_TOKEN']
    worker = os.environ['EXPECTED_WORKER']
    domain = os.environ['EXPECTED_DOMAIN']
    commit = os.environ['SOURCE_COMMIT']
    root = os.environ['ROOT_DIGEST']
    tag = 'ci-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
    if not re.fullmatch(r'[0-9a-f]{32}', account) or not re.fullmatch(r'ssl-recovery-[a-z0-9-]+', worker) or not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'[0-9a-f]{64}', root) or not re.fullmatch(r'ci-[0-9]+-[0-9]+', tag):
        raise ValueError('Invalid deployment identity')
    output = re.sub(r'\x1b\[[0-9;]*m', '', os.environ['WRANGLER_UPLOAD_OUTPUT'])
    ids = re.findall(r'Worker Version ID:\s*(' + UUID + r')\b', output)
    if len(ids) != 1:
        raise ValueError('Successful Wrangler upload must identify exactly one version')
    version_id = ids[0]
    bundle = Path('_ssl_bundle')
    verify(bundle, worker, domain, Path('.cloudflare/wrangler.jsonc'), root)
    versions = request(account, worker, token, '/versions')['items']
    matches = [v for v in versions if v.get('annotations', {}).get('workers/tag') == tag]
    if len(matches) != 1 or matches[0].get('id') != version_id:
        raise ValueError('Expected exactly one uploaded version with this unique CI tag')
    version = request(account, worker, token, '/versions/' + version_id)
    attest(version, version_id, tag, commit, root, bundle)
    payload = {'strategy': 'percentage', 'versions': [{'version_id': version_id, 'percentage': 100}]}
    deployment = request(account, worker, token, '/deployments', payload)
    if not deployment.get('id'):
        raise RuntimeError('Deployment did not return its ID')
    for attempt in range(4):
        live = request(account, worker, token, '/deployments')['deployments']
        if live and live[0].get('id') == deployment['id'] and live[0].get('versions') == payload['versions']:
            result = {'worker': worker, 'source_commit': commit, 'root_manifest_sha256': root, 'version_id': version_id, 'deployment_id': deployment['id'], 'percentage': 100}
            Path('.cloudflare/deployment-result.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
            with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a') as summary:
                summary.write('Verified Worker deployment: `' + json.dumps(result, sort_keys=True) + '`\n')
            print(json.dumps(result, sort_keys=True))
            return
        if attempt < 3:
            time.sleep(2)
    raise RuntimeError('Deployment readback did not confirm this exact version at 100%')


if __name__ == '__main__':
    main()
