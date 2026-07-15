// 云端共享存储：以 GitHub 仓库为后端（Fine-grained PAT + Contents API）
// 数据存于独立分支 packflow-data / skus.json，不影响 GitHub Pages 站点。
export const GH = {
  owner: 'DtoneEthan',
  repo: 'packflow',
  branch: 'packflow-data',
  path: 'skus.json',
};

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
// Unicode 安全的 base64
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64.replace(/\s/g, '')))); }

// 读取云端文件；不存在返回 null
export async function ghGetFile(token) {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}?ref=${GH.branch}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error('令牌无效或权限不足（401）');
  if (res.status === 403) throw new Error('令牌无权限或被限流（403）');
  if (!res.ok) throw new Error('读取云端失败：HTTP ' + res.status);
  const d = await res.json();
  if (!d.content) return null;
  return { sha: d.sha, content: b64decode(d.content) };
}

// 创建独立分支（首次上传时）
async function createBranch(token) {
  const base = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/git/refs/heads/main`, { headers: headers(token) });
  if (!base.ok) throw new Error('无法获取 main 分支（HTTP ' + base.status + '）');
  const sha = (await base.json()).object.sha;
  const res = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/git/refs`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${GH.branch}`, sha }),
  });
  if (!res.ok && res.status !== 422) throw new Error('创建分支失败：HTTP ' + res.status);
}

export async function ghPutFile(token, content, sha) {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`;
  const body = {
    message: 'PackFlow: 更新共享 SKU',
    content: b64encode(content),
    branch: GH.branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 分支不存在 → 创建后重试一次
  if (res.status === 422 && !sha) {
    await createBranch(token);
    return ghPutFile(token, content, undefined);
  }
  // 并发冲突（sha 不匹配）→ 重新取 sha 再试一次
  if (res.status === 409 && sha) {
    const cur = await ghGetFile(token);
    return ghPutFile(token, content, cur ? cur.sha : undefined);
  }
  if (!res.ok) throw new Error('写入云端失败：HTTP ' + res.status);
  const d = await res.json();
  return d.content.sha;
}

// 上传：自动处理"文件不存在/分支不存在"
export async function pushSkus(token, json) {
  const cur = await ghGetFile(token); // 可能 null
  return ghPutFile(token, json, cur ? cur.sha : undefined);
}

// 拉取：返回文件文本，空则返回 null
export async function pullSkus(token) {
  const cur = await ghGetFile(token);
  return cur ? cur.content : null;
}
