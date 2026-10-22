"""Generate deterministic assets-only routes that preserve observed GitHub Pages semantics."""
import argparse, hashlib, json, os, pathlib

def generate(assets):
    assets=pathlib.Path(assets).resolve();html=[]
    for folder,_,names in os.walk(assets):
        for name in names:
            path=pathlib.Path(folder)/name
            if path.is_symlink():raise ValueError('Symlink is not allowed: '+str(path))
            if path.suffix.lower()=='.html':html.append(path.relative_to(assets).as_posix())
    rules={}
    for rel in sorted(html):
        rules['/'+rel[:-5]]=('/'+rel,200)
    for rel in sorted(html):
        if rel=='index.html':rules['/']=('/index.html',200)
        elif rel.endswith('/index.html'):
            directory='/'+rel[:-len('/index.html')]
            flat=assets/(directory.lstrip('/')+'.html')
            rules[directory]=(directory+'.html',200) if flat.is_file() else (directory+'/',301)
            rules[directory+'/']=(directory+'/index.html',200)
    text='\n'.join(f'{source} {target} {status}' for source,(target,status) in sorted(rules.items()))+'\n'
    if len(rules)>2000:raise ValueError('Static routing entries exceed Cloudflare limit')
    return text,{'html_files':len(html),'static_rules':len(rules),'sha256':hashlib.sha256(text.encode()).hexdigest(),'policy':'html_handling none; exact HTML and index paths stay200; extensionless flatHTML200; directory301 only without siblingflatHTML; directoryslash200rewrite; defaultroot404'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('assets');p.add_argument('--manifest');args=p.parse_args()
    text,manifest=generate(args.assets);(pathlib.Path(args.assets)/'_redirects').write_text(text)
    if args.manifest:pathlib.Path(args.manifest).write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
    print(json.dumps(manifest,sort_keys=True))
