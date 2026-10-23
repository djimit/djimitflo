"""Read-only, bounded SKILL.md identity/hash inventory. Never executes a skill or emits its instruction body."""
from pathlib import Path
import hashlib,json,os,re,sys
from datetime import datetime,timezone
roots=[Path(a).expanduser() for a in sys.argv[1:]] or [Path.home()/p for p in ['.hermes/skills','.hermes/profiles/djimit2-bot/skills','.openclaw/workspace/skills','.openclaw/skills','agent-skills']]
rows=[];coverage=[]
for root in roots:
    visited=set();capped=False
    if root.exists():
        for directory,dirs,files in os.walk(root,followlinks=True):
            resolved=str(Path(directory).resolve())
            if resolved in visited:dirs[:]=[];continue
            visited.add(resolved)
            dirs[:]=[d for d in dirs if d not in ['.git','node_modules','.venv','__pycache__']]
            if len(visited)>10000:capped=True;break
            if 'SKILL.md' not in files:continue
            p=Path(directory)/'SKILL.md';data=p.read_bytes();text=data.decode('utf8',errors='replace')
            fm=re.match(r'^---\s*\n(.*?)\n---\s*\n',text,re.S)
            body=text[fm.end():] if fm else text
            def field(name):
                m=re.search(r'^'+re.escape(name)+r':\s*([^\n]+)',fm.group(1),re.M) if fm else None
                value=m.group(1).strip().strip('\"\'') if m else None
                return value if value and len(value)<120 and not re.search(r'sk-|ghp_|nvapi-',value) else None
            rows.append({'root':str(root),'path':str(p.relative_to(root)),'resolved':str(p.resolve()),'sha256':hashlib.sha256(data).hexdigest(),'body_sha256':hashlib.sha256(re.sub(r'\s+',' ',body).strip().encode()).hexdigest(),'name':field('name'),'version':field('version'),'lifecycle':field('lifecycle'),'manifest':(p.parent/'skill.manifest.yaml').exists(),'scripts':(p.parent/'scripts').is_dir(),'lines':len(text.splitlines())})
    coverage.append({'root':str(root),'exists':root.exists(),'visited_directories':len(visited),'capped':capped})
assert all(re.fullmatch(r'[a-f0-9]{64}',r['sha256']) for r in rows)
print(json.dumps({'captured_at':datetime.now(timezone.utc).isoformat(),'scope':'SKILL.md packages only, symlinks followed with realpath cycle guard; metadata/hashes only','coverage':coverage,'skills':rows},indent=2))
