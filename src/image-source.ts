import { fetch as proxyFetch, ProxyAgent } from 'undici';

const imageLimit = 20 * 1024 * 1024;
const proxyAgents = new Map<string, ProxyAgent>();

function imageProxy(url: string, configuredProxy = ''): string {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return '';
  const exceptions = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(item => item.trim().toLowerCase());
  if (exceptions.some(item => item === '*' || item && (host === item.replace(/^\./, '') || host.endsWith(`.${item.replace(/^\./, '')}`)))) return '';
  return configuredProxy.trim() || (target.protocol === 'https:' ? process.env.HTTPS_PROXY || process.env.https_proxy :
    process.env.HTTP_PROXY || process.env.http_proxy) || '';
}

function imageMime(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 64));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (head.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (head.toString('ascii', 4, 12).includes('ftypavif')) return 'image/avif';
  const text = Buffer.from(bytes.subarray(0, 4096)).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (/^(?:<\?xml\b[^>]*>\s*)?<svg[\s>]/i.test(text)) return 'image/svg+xml';
  throw new Error('图片格式不受支持（支持 PNG、JPEG、GIF、WebP、BMP、AVIF、SVG）');
}

async function remoteBytes(url: string, configuredProxy = ''): Promise<Uint8Array> {
  const options = { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(15000) };
  const proxy = imageProxy(url, configuredProxy);
  let response;
  if (proxy) {
    let agent = proxyAgents.get(proxy);
    if (!agent) { agent = new ProxyAgent(proxy); proxyAgents.set(proxy, agent); }
    response = await proxyFetch(url, { ...options, dispatcher: agent });
  } else response = await fetch(url, options);
  if (!response.ok || !response.body) throw new Error(`图片下载失败：HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > imageLimit) throw new Error('图片不能超过 20 MB');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > imageLimit) throw new Error('图片不能超过 20 MB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, size);
}

export async function imageDataUrl(source: string, readLocal: (source: string) => Promise<Uint8Array>, proxy = ''): Promise<string> {
  const raw = source.trim();
  const remote = raw.startsWith('//') ? `https:${raw}` : /^https?:\/\//i.test(raw) ? raw : '';
  if (!raw || (!remote && /^[a-z][\w+.-]*:/i.test(raw) && !/^file:/i.test(raw)))
    throw new Error('图片地址必须是相对路径、文件路径或 HTTP(S) 网址');
  const bytes = remote ? await remoteBytes(remote, proxy) : await readLocal(raw);
  if (bytes.byteLength > imageLimit) throw new Error('图片不能超过 20 MB');
  return `data:${imageMime(bytes)};base64,${Buffer.from(bytes).toString('base64')}`;
}
