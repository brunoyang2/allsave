require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_TTL = 15 * 60 * 1000; // 15 minutos

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// token -> { links: { formato: url }, plataforma, headers: {}, expiresAt }
const downloadSessions = new Map();

// Gerador e resolvedor de tokens stateless compactos (Garante compatibilidade total na nuvem Vercel Serverless sem estourar o limite de cabeçalho HTTP 431)
const SESSION_SECRET = process.env.SESSION_SECRET || 'vidsave-secure-token-engine-2026';
const TOKEN_KEY = crypto.scryptSync(SESSION_SECRET, 'vidsave-salt-2026', 32);

function generateFormatToken(linkUrl, headers) {
  try {
    const iv = crypto.randomBytes(12);
    const dataBuf = Buffer.from(JSON.stringify({ u: linkUrl, h: headers || {}, exp: Date.now() + SESSION_TTL }));
    const comp = zlib.deflateRawSync(dataBuf);
    const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
    const enc = Buffer.concat([cipher.update(comp), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url');
  } catch (e) {
    return null;
  }
}

function resolveFormatToken(tokenStr) {
  try {
    const buf = Buffer.from(tokenStr, 'base64url');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    const decomp = zlib.inflateRawSync(dec);
    const parsed = JSON.parse(decomp.toString('utf8'));
    if (!parsed || parsed.exp < Date.now()) return null;
    return { fileUrl: parsed.u, headers: parsed.h };
  } catch (e) {
    return null;
  }
}

function generateSessionToken(payload) {
  try {
    const json = JSON.stringify(payload);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
    const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url');
  } catch (e) {
    return crypto.randomBytes(24).toString('hex');
  }
}

function resolveSessionToken(tokenStr) {
  // 1. Tenta Map local em memória (localhost)
  const local = downloadSessions.get(tokenStr);
  if (local && local.expiresAt >= Date.now()) return local;

  // 2. Decodifica token stateless assinado (Vercel Serverless multi-instâncias)
  try {
    const buf = Buffer.from(tokenStr, 'base64url');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    const parsed = JSON.parse(dec.toString('utf8'));
    if (!parsed || parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of downloadSessions) if (s.expiresAt < now) downloadSessions.delete(token);
}, 60 * 1000);

const REGEX = {
  tiktok: /^(https?:\/\/)?([\w-]+\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i,
  instagram: /^(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/(reel|reels|p|stories|tv)\//i,
  facebook: /^(https?:\/\/)?([\w-]+\.)?(facebook\.com|fb\.watch|fb\.com)\//i,
  youtube: /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i,
};

function detectPlatform(url) {
  for (const [name, rx] of Object.entries(REGEX)) if (rx.test(url)) return name;
  return null;
}

// Localizador dinâmico do executável yt-dlp (Windows local bin ou Linux/PATH)
function getYtDlpBinary() {
  const localWin = path.join(__dirname, 'bin', 'yt-dlp.exe');
  const localLinux = path.join(__dirname, 'bin', 'yt-dlp');
  if (process.platform === 'win32' && fs.existsSync(localWin)) return localWin;
  if (fs.existsSync(localLinux)) return localLinux;
  return 'yt-dlp';
}

// Extração local via yt-dlp (Sem necessidade de chaves de terceiros)
function extractWithYtDlp(url) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpBinary();
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      url
    ];

    execFile(bin, args, { maxBuffer: 15 * 1024 * 1024, timeout: 35000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message || 'Falha ao processar vídeo com yt-dlp.'));
      }
      try {
        const info = JSON.parse(stdout);
        const videoUrl = info.url || (info.requested_downloads && info.requested_downloads[0]?.url);
        if (!videoUrl) {
          return reject(new Error('Nenhum fluxo direto de vídeo foi encontrado para este link.'));
        }
        resolve({
          titulo: info.title || 'Vídeo Extraído',
          thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[0]?.url) || '',
          links: {
            video_hd: videoUrl,
          },
          headers: info.http_headers || {},
        });
      } catch (e) {
        reject(new Error('Erro ao processar resposta do motor de download.'));
      }
    });
  });
}

// Extração TikTok via TikWM (rápida, grátis, sem chave)
async function extractTikTok(url) {
  try {
    const { data } = await axios.get('https://www.tikwm.com/api/', {
      params: { url, hd: 1 },
      timeout: 15000,
    });
    if (!data || data.code !== 0 || !data.data) throw new Error(data?.msg || 'Erro na API TikWM');
    const d = data.data;
    const abs = (u) => (u && u.startsWith('/') ? `https://www.tikwm.com${u}` : u);
    return {
      titulo: d.title || 'Vídeo do TikTok',
      thumbnail: abs(d.origin_cover || d.cover),
      links: {
        no_watermark_hd: abs(d.hdplay || d.play),
        watermark_low: abs(d.wmplay),
        audio_mp3: abs(d.music),
      },
      headers: { Referer: 'https://www.tikwm.com/' }
    };
  } catch (err) {
    console.log('[TikTok] Tentando fallback para yt-dlp...', err.message);
    const fallback = await extractWithYtDlp(url);
    return {
      titulo: fallback.titulo,
      thumbnail: fallback.thumbnail,
      links: {
        no_watermark_hd: fallback.links.video_hd,
        watermark_low: fallback.links.video_hd,
        audio_mp3: fallback.links.video_hd,
      },
      headers: fallback.headers,
    };
  }
}

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '353dc56353mshd05a55207355d90p17d18fjsndffbf9ceab6c';

// Extração dedicada Instagram via RapidAPI (Kk Creation)
async function extractInstagram(url) {
  if (!RAPIDAPI_KEY) return null;
  try {
    const { data } = await axios.get(
      'https://instagram-downloader-download-instagram-stories-videos4.p.rapidapi.com/convert',
      {
        params: { url },
        timeout: 15000,
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'instagram-downloader-download-instagram-stories-videos4.p.rapidapi.com',
        },
      }
    );
    if (data && Array.isArray(data.media) && data.media.length > 0) {
      const item = data.media.find((m) => m.type === 'video') || data.media[0];
      if (item && item.url) {
        return {
          titulo: `Instagram ${item.type === 'video' ? 'Reels' : 'Post'}`,
          thumbnail: item.thumbnail || item.url,
          links: { video_hd: item.url },
          headers: {},
        };
      }
    }
  } catch (err) {
    console.warn('[Instagram API 1]', err.message);
  }
  return null;
}

// Função para priorizar sempre a maior qualidade disponível (1080p / 1920 / HD)
function scoreResolution(m) {
  if (!m || m.type !== 'video' || !m.url) return -1;
  const q = String(m.quality || '').toUpperCase();
  const r = String(m.resolution || '').toUpperCase();
  const w = parseInt(m.width || '0', 10);
  const h = parseInt(m.height || '0', 10);

  // 1. Se tiver dimensões explícitas (ex: 1080x1920 ou 1920x1080)
  const maxDim = Math.max(w, h);
  if (maxDim > 0) return maxDim;

  // 2. Extrai números de resolução (ex: 1080, 1920, 720)
  const numbers = (q + ' ' + r).match(/\d{3,4}/g);
  if (numbers) {
    const nums = numbers.map((n) => parseInt(n, 10));
    return Math.max(...nums);
  }

  // 3. Pesos para rótulos de qualidade
  if (q.includes('4K') || q.includes('2160')) return 2160;
  if (q.includes('2K') || q.includes('1440')) return 1440;
  if (q.includes('1080') || q.includes('FHD') || q.includes('FULL HD') || q.includes('HD_NO_WATERMARK')) return 1080;
  if (q === 'HD' || q.includes('HD')) return 1080;
  if (q.includes('720')) return 720;
  if (q === 'SD' || q.includes('SD')) return 480;

  return 0;
}

// Extração Instagram / Facebook (RapidAPI prioritária, com fallback inteligente)
async function extractMeta(url, plataforma) {
  // 1. Tenta API especializada se for Instagram
  if (plataforma === 'instagram' && RAPIDAPI_KEY) {
    const igResult = await extractInstagram(url);
    if (igResult) return igResult;
  }

  // 2. Tenta API Social Download All In One (Excelente para Facebook e Instagram Reels)
  if (RAPIDAPI_KEY) {
    try {
      const { data } = await axios.post(
        'https://social-download-all-in-one.p.rapidapi.com/v1/social/autolink',
        { url },
        {
          timeout: 20000,
          headers: {
            'Content-Type': 'application/json',
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': 'social-download-all-in-one.p.rapidapi.com',
          },
        }
      );
      if (data && !data.error && Array.isArray(data.medias)) {
        const videos = data.medias.filter((m) => m.type === 'video' && m.url);
        if (videos.length) {
          // Ordena rigorosamente da maior para a menor resolução para garantir 1080p
          videos.sort((a, b) => scoreResolution(b) - scoreResolution(a));
          const bestVideo = videos[0];
          return {
            titulo: data.title || `Vídeo do ${plataforma === 'instagram' ? 'Instagram' : 'Facebook'}`,
            thumbnail: data.thumbnail || (bestVideo.thumbnail || ''),
            links: { video_hd: bestVideo.url },
            headers: {},
          };
        }
      }
    } catch (err) {
      console.warn('[RapidAPI Meta]', err.message);
    }
  }

  // 3. Se estiver na Vercel, o yt-dlp não existe no ambiente serverless (retorna erro amigável)
  if (process.env.VERCEL) {
    throw new Error(`Não foi possível extrair este vídeo do ${plataforma === 'instagram' ? 'Instagram' : 'Facebook'}. Verifique se o conteúdo é público.`);
  }

  // 4. Fallback para o motor local yt-dlp em desenvolvimento
  return await extractWithYtDlp(url);
}

// Extração YouTube Local via yt-dlp (Desenvolvimento)
function extractYouTubeLocal(url) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpBinary();
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      url
    ];

    execFile(bin, args, { maxBuffer: 30 * 1024 * 1024, timeout: 45000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error('Falha ao processar este vídeo do YouTube. Verifique se o vídeo é público.'));
      }
      try {
        const info = JSON.parse(stdout);
        const formats = info.formats || [];

        // Filtra apenas formatos com URL direta HTTPS
        const direct = formats.filter(f => f.url && (f.protocol === 'https' || f.protocol === 'http'));

        // Encontra formatos para 1080p, 720p, 480p e áudio
        const f1080 = direct.find(f => f.format_id === '137') || direct.find(f => f.height === 1080) || direct.find(f => f.height >= 1080);
        const f720 = direct.find(f => f.format_id === '136') || direct.find(f => f.height === 720) || direct.find(f => f.height >= 720);
        const f480 = direct.find(f => f.format_id === '135') || direct.find(f => f.height === 480) || direct.find(f => f.height === 360);
        const anyVideo = direct.filter(f => f.vcodec !== 'none').pop();

        // Encontra fluxo de áudio direto
        const fAudioM4A = direct.find(f => f.format_id && f.format_id.startsWith('140')) || direct.find(f => f.acodec !== 'none' && f.ext === 'm4a');
        const fAudioOpus = direct.find(f => f.format_id && f.format_id.startsWith('251')) || direct.find(f => f.acodec !== 'none');
        const audioUrl = fAudioM4A?.url || fAudioOpus?.url || (direct.find(f => f.acodec !== 'none')?.url);

        const video1080 = f1080?.url || f720?.url || anyVideo?.url;
        const video720 = f720?.url || f1080?.url || anyVideo?.url;
        const video480 = f480?.url || f720?.url || anyVideo?.url;

        if (!video1080 && !audioUrl) {
          return reject(new Error('Nenhum fluxo direto de download disponível para este link.'));
        }

        const thumbnail = info.thumbnail || (info.thumbnails && info.thumbnails.pop()?.url) || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
        const isVertical = (info.width && info.height) ? (info.height > info.width) : false;

        const headers = f1080?.http_headers || fAudioM4A?.http_headers || {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        resolve({
          titulo: info.title || 'Vídeo do YouTube',
          thumbnail: thumbnail,
          isVertical: isVertical,
          links: {
            video_1080p: video1080,
            video_720p: video720,
            video_480p: video480,
            audio_320k: audioUrl,
            audio_192k: audioUrl,
            audio_128k: audioUrl,
          },
          headers: headers,
        });
      } catch (e) {
        reject(new Error('Erro ao processar formatos do vídeo do YouTube: ' + e.message));
      }
    });
  });
}

// Extração YouTube (Nuvem Vercel via RapidAPI prioritária com Fallback local)
async function extractYouTube(url) {
  if (RAPIDAPI_KEY) {
    try {
      const { data } = await axios.post(
        'https://social-download-all-in-one.p.rapidapi.com/v1/social/autolink',
        { url },
        {
          timeout: 25000,
          headers: {
            'Content-Type': 'application/json',
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': 'social-download-all-in-one.p.rapidapi.com',
          },
        }
      );
      if (data && !data.error && Array.isArray(data.medias)) {
        const medias = data.medias.filter((m) => m.url);
        const f1080 = medias.find((m) => m.type === 'video' && m.quality && m.quality.includes('1080'));
        const f720 = medias.find((m) => m.type === 'video' && m.quality && m.quality.includes('720'));
        const f480 = medias.find((m) => m.type === 'video' && m.quality && (m.quality.includes('480') || m.quality.includes('360')));
        const anyVideo = medias.find((m) => m.type === 'video') || medias[0];

        const fAudioM4A = medias.find((m) => m.type === 'audio' && m.extension === 'm4a');
        const anyAudio = medias.find((m) => m.type === 'audio' || m.extension === 'mp3' || m.is_audio);
        const audioUrl = fAudioM4A?.url || anyAudio?.url || anyVideo?.url;

        const video1080 = f1080?.url || f720?.url || anyVideo?.url;
        const video720 = f720?.url || f1080?.url || anyVideo?.url;
        const video480 = f480?.url || f720?.url || anyVideo?.url;

        return {
          titulo: data.title || 'Vídeo do YouTube',
          thumbnail: data.thumbnail || '',
          isVertical: false,
          links: {
            video_1080p: video1080,
            video_720p: video720,
            video_480p: video480,
            audio_320k: audioUrl,
            audio_192k: audioUrl,
            audio_128k: audioUrl,
          },
          headers: {},
        };
      }
    } catch (err) {
      console.warn('[RapidAPI YouTube]', err.message);
    }
  }

  // Se estiver na Vercel e a API falhou
  if (process.env.VERCEL) {
    throw new Error('Não foi possível extrair este vídeo do YouTube. Verifique se o conteúdo é público.');
  }

  // Fallback para o motor local yt-dlp em desenvolvimento
  return await extractYouTubeLocal(url);
}

app.post('/api/extract', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ sucesso: false, erro: 'Informe uma URL.' });
    const plataforma = detectPlatform(url);
    if (!plataforma) return res.status(400).json({ sucesso: false, erro: 'Link não suportado. Use YouTube, TikTok, Instagram ou Facebook.' });

    let result;
    if (plataforma === 'tiktok') {
      result = await extractTikTok(url);
    } else if (plataforma === 'youtube') {
      result = await extractYouTube(url);
    } else {
      result = await extractMeta(url, plataforma);
    }

    const sessionData = {
      links: result.links,
      plataforma,
      headers: result.headers || {},
      expiresAt: Date.now() + SESSION_TTL
    };

    // Gera tokens compactos para cada formato (~1KB cada, livre de erros de limite HTTP 431)
    const tokens = {};
    for (const [fmt, linkUrl] of Object.entries(result.links || {})) {
      tokens[fmt] = generateFormatToken(linkUrl, result.headers);
    }
    const token = tokens[Object.keys(tokens)[0]] || generateSessionToken(sessionData);
    downloadSessions.set(token, sessionData);

    res.json({
      sucesso: true,
      token,
      tokens,
      plataforma,
      titulo: result.titulo,
      thumbnail: result.thumbnail
    });
  } catch (err) {
    console.error('[extract]', err.message);
    res.status(err.status || 502).json({ sucesso: false, erro: err.message || 'Erro ao processar o link.' });
  }
});

// Proxy de miniatura (evita bloqueio de hotlink/CORS de CDNs)
app.get('/api/thumb', async (req, res) => {
  const u = String(req.query.u || '');
  if (!/^https:\/\//i.test(u)) return res.status(400).end();
  try {
    const r = await axios.get(u, { responseType: 'stream', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=900');
    r.data.pipe(res);
  } catch {
    res.status(404).end();
  }
});

app.get(['/api/download/:token', '/api/download/:token/:filename', '/api/download/:token/:formato/:filename'], async (req, res) => {
  const { token, formato, filename: reqFilename } = req.params;
  let fileUrl = null;
  let sessionHeaders = {};

  // 1. Tenta resolver como token de formato compacto (100% compatível com Vercel, ~1KB)
  const resolvedFmt = resolveFormatToken(token);
  if (resolvedFmt && resolvedFmt.fileUrl) {
    fileUrl = resolvedFmt.fileUrl;
    sessionHeaders = resolvedFmt.headers || {};
  } else {
    // 2. Tenta resolver via session map ou token de sessão legado
    const session = resolveSessionToken(token);
    if (session && session.links) {
      fileUrl = session.links[formato] || Object.values(session.links)[0];
      sessionHeaders = session.headers || {};
    }
  }

  if (!fileUrl) {
    return res.status(410).send('Link de download expirado ou inválido. Por favor, gere novamente.');
  }

  const isAudio = (req.path.includes('.mp3') || String(formato || '').startsWith('audio_'));
  const random7 = Math.floor(1000000 + Math.random() * 9000000);
  const defaultFilename = isAudio ? `vidsave-${random7}.mp3` : `vidsave-${random7}.mp4`;
  const filename = reqFilename || defaultFilename;

  try {
    const reqHeaders = {
      'User-Agent': sessionHeaders['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(sessionHeaders['Referer'] ? { Referer: sessionHeaders['Referer'] } : {}),
      ...(sessionHeaders['cookies'] ? { Cookie: sessionHeaders['cookies'] } : {}),
    };

    const upstream = await axios({
      url: fileUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 25000,
      maxRedirects: 5,
      headers: reqHeaders,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.pipe(res);
    req.on('close', () => upstream.data.destroy());
  } catch (err) {
    console.warn('[download proxy fallback]', err.message, 'Redirecionando...');
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.redirect(302, fileUrl);
    }
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`VidSave rodando em http://localhost:${PORT}`));
}

module.exports = app;
