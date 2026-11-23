// Lists your GitHub repositories. The token comes from the environment, put
// there by facedown; this program never knows it came from a vault.
//
//   facedown run --keys GITHUB_TOKEN -- node index.js

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is not set. Run me with: facedown run --keys GITHUB_TOKEN -- node index.js');
  process.exit(1);
}

// Printing a secret by accident is harmless under facedown: the output shows
// ***GITHUB_TOKEN*** instead. (Shown here on purpose, so you can see it.)
console.log(`[debug] using token ${token}`);

const res = await fetch('https://api.github.com/user/repos?per_page=10&sort=updated', {
  headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'facedown-example', Accept: 'application/vnd.github+json' },
});
const body = await res.json();
if (!res.ok) {
  console.error(`GitHub said ${res.status}: ${body.message}`);
  process.exitCode = 1; // not process.exit(): let open connections close first
} else {
  for (const repo of body) console.log(`${repo.private ? 'private' : 'public '}  ${repo.full_name}`);
}
