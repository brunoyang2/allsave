require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
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

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of downloadSessions) if (s.expiresAt < now) downloadSessions.delete(token);
}, 60 * 1000);

const REGEX = {
  tiktok: /^(https?:\/\/)?([\w-]+\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i,
  instagram: /^(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/(reel|reels|p|stories|tv)\//i,
  facebook: /^(https?:\/\/)?([\w-]+\.)?(facebook\.com|fb\.watch|fb\.com)\//i,
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

// Extração Instagram / Facebook (RapidAPI se configurada, ou yt-dlp local sem chave)
async function extractMeta(url, plataforma) {
  // 1. Se a chave RAPIDAPI_KEY existir, tenta primeiro a RapidAPI
  if (process.env.RAPIDAPI_KEY) {
    try {
      const { data } = await axios.post(
        'https://social-download-all-in-one.p.rapidapi.com/v1/social/autolink',
        { url },
        {
          timeout: 20000,
          headers: {
            'Content-Type': 'application/json',
            'x-rapidapi-key': process.env.RAPIDAPI_KEY,
            'x-rapidapi-host': 'social-download-all-in-one.p.rapidapi.com',
          },
        }
      );
      if (data && !data.error && Array.isArray(data.medias)) {
        const videos = data.medias.filter((m) => m.type === 'video' && m.url);
        if (videos.length) {
          const pickRes = (m) => parseInt(String(m.quality || m.resolution || '').match(/\d{3,4}/)?.[0] || '0', 10);
          videos.sort((a, b) => pickRes(b) - pickRes(a));
          return {
            titulo: data.title || `Vídeo do ${plataforma === 'instagram' ? 'Instagram' : 'Facebook'}`,
            thumbnail: data.thumbnail || '',
            links: { video_hd: videos[0].url },
            headers: {},
          };
        }
      }
    } catch (err) {
      console.warn('[RapidAPI] Erro ao consultar API, usando yt-dlp local...', err.message);
    }
  }

  // 2. Fallback imediato para o motor local yt-dlp (Gratuito, sem necessidade de chave)
  return await extractWithYtDlp(url);
}

app.post('/api/extract', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ sucesso: false, erro: 'Informe uma URL.' });
    const plataforma = detectPlatform(url);
    if (!plataforma) return res.status(400).json({ sucesso: false, erro: 'Link não suportado. Use TikTok, Instagram ou Facebook.' });

    const result = plataforma === 'tiktok' ? await extractTikTok(url) : await extractMeta(url, plataforma);

    const token = crypto.randomBytes(24).toString('hex');
    downloadSessions.set(token, {
      links: result.links,
      plataforma,
      headers: result.headers || {},
      expiresAt: Date.now() + SESSION_TTL
    });

    res.json({ sucesso: true, token, plataforma, titulo: result.titulo, thumbnail: result.thumbnail });
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

app.get('/api/download/:token/:formato', async (req, res) => {
  const { token, formato } = req.params;
  const session = downloadSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    downloadSessions.delete(token);
    return res.status(410).send('Link expirado. Volte e gere o download novamente.');
  }
  const fileUrl = session.links[formato];
  if (!fileUrl) return res.status(404).send('Formato indisponível.');

  try {
    const reqHeaders = {
      'User-Agent': session.headers?.['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(session.headers?.['Referer'] ? { Referer: session.headers['Referer'] } : {}),
      ...(session.headers?.['cookies'] ? { Cookie: session.headers['cookies'] } : {}),
    };

    const upstream = await axios({
      url: fileUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 35000,
      maxRedirects: 5,
      headers: reqHeaders,
    });

    const isAudio = formato === 'audio_mp3';
    const filename = isAudio ? 'allsave-audio.mp3' : 'allsave-video.mp4';
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.pipe(res);
    req.on('close', () => upstream.data.destroy());
  } catch (err) {
    console.error('[download]', err.message);
    if (!res.headersSent) res.status(502).send('Falha ao baixar o arquivo da origem. Tente novamente.');
  }
});

app.listen(PORT, () => console.log(`AllSave rodando em http://localhost:${PORT}`));
