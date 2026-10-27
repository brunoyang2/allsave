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

  // Apenas redireciona se for CDN protegida da Meta (Facebook/Instagram), pois bloqueiam stream de IP de servidor.
  // Para TikTok e outras fontes, faz o stream proxy com cabeçalho forçado de download (Content-Disposition: attachment).
  const isMetaCdn = /fbcdn\.net|cdninstagram\.com|instagram\.com/i.test(fileUrl);
  if (isMetaCdn) {
    return res.redirect(302, fileUrl);
  }

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
      timeout: 25000,
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
    console.warn('[download proxy fallback]', err.message, 'Redirecionando direto para a URL original...');
    if (!res.headersSent) {
      return res.redirect(302, fileUrl);
    }
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`AllSave rodando em http://localhost:${PORT}`));
}

module.exports = app;
