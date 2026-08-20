const repos = require('/dev/stdin');
const publicActive = repos
  .filter(r => !r.private && !r.archived && !r.fork)
  .map(r => ({
    name: r.name,
    full_name: r.full_name,
    description: r.description || '',
    language: r.language || '',
    html_url: r.html_url,
    topics: r.topics || [],
    stargazers: r.stargazers_count,
    updated: r.updated_at,
    default_branch: r.default_branch,
  }))
  .sort((a,b) => b.stargazers - a.stargazers);
console.log(JSON.stringify(publicActive, null, 2));
