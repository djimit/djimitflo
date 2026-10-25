"""Read the pinned reachable history; never fetches or changes a worktree."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
scope = json.loads((ROOT / 'scope.json').read_text())


def git(*args):
    return subprocess.check_output(['git', *args], text=True, cwd=ROOT)


def history(first_parent):
    args = ['log', scope['baseline_sha'], '--since-as-filter=' + scope['window_start'],
            '--until=' + scope['window_end'], '--format=%H%x1f%P%x1f%aI%x1f%cI%x1f%an%x1f%s']
    if first_parent:
        args.append('--first-parent')
    result = []
    for line in git(*args).splitlines():
        sha, parents, author_date, committed_date, author, subject = line.split('\x1f', 5)
        row = dict(sha=sha, parents=parents.split(), author_date=author_date,
                   committed_date=committed_date, author=author, subject=subject)
        if first_parent:
            row['files'] = []
            # Retain both paths of a move as changed paths, rather than Git's compact rename notation.
            for item in git('show', '--format=', '--numstat', '--no-renames', '--diff-merges=first-parent', sha).splitlines():
                additions, deletions, path = item.split('\t', 2)
                row['files'].append(dict(path=path, additions=int(additions) if additions != '-' else None,
                                         deletions=int(deletions) if deletions != '-' else None))
        result.append(row)
    assert len({r['sha'] for r in result}) == len(result)
    return result


if __name__ == '__main__':
    data = dict(scope=scope, first_parent_commits=history(True), all_reachable_window_commits=history(False))
    (ROOT / 'git-history.json').write_text(json.dumps(data, indent=2) + '\n')
    print('Pinned mainline commits:', len(data['first_parent_commits']))
