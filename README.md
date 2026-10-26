# AllSave ⚡ - Downloader de Vídeos sem Marca d'Água

Aplicação web completa para extrair e baixar vídeos do **TikTok** (sem marca d'água e em alta definição), **Instagram Reels/Stories** e **Facebook**, com suporte nativo a monetização via **Anúncios Premiados (Rewarded Video Ads)** e motor local `yt-dlp`.

---

## 🚀 Tecnologias Utilizadas

- **Back-end:** Node.js, Express, Axios, CORS, Dotenv, Crypto (sistema seguro de tokens de download com expiração).
- **Motores de Extração:**
  - API pública TikWM (TikTok 1080p sem marca d'água + áudio MP3 original).
  - Utilitário open-source `yt-dlp` local integrado (suporte a Instagram, Facebook e fallback sem chaves de terceiros).
  - Suporte opcional a RapidAPI (`social-download-all-in-one`).
- **Front-end:** HTML5 semântico, Tailwind CSS (tema escuro `bg-slate-950`), Vanilla JS, Clipboard API.
- **Monetização:** Modal de Anúncio Premiado em 2 etapas com suporte a VAST Tag e eventos `onended` para liberar o download.
- **SEO:** Otimizado com Open Graph, Twitter Cards, seções explicativas e FAQ com marcação Schema.org (`WebApplication`).

---

## 📦 Como Instalar e Rodar Localmente

1. **Clone o repositório:**
   ```bash
   git clone https://github.com/brunoyang2/allsave.git
   cd allsave
   ```

2. **Instale as dependências:**
   ```bash
   npm install
   ```

3. **Configure as variáveis de ambiente:**
   Copie o arquivo de exemplo:
   ```bash
   cp .env.example .env
   ```

4. **Inicie o servidor:**
   ```bash
   npm start
   ```
   Acesse no navegador: [http://localhost:3000](http://localhost:3000)

---

## ⚙️ Atualização do Motor de Download

Para atualizar o binário do `yt-dlp` para a versão mais recente diretamente do repositório oficial:
```bash
npm run update-ytdlp
```

---

## 💰 Monetização com Anúncios Reais

O modal de anúncio premiado no arquivo `public/index.html` já está estruturado com bloqueio de download até o término do vídeo. Você pode plugar redes como **Monetag**, **Adsterra** ou **ExoClick** usando VAST Tag ou scripts de Rewarded Interstitials.

---

## 📄 Licença

Distribuído sob a licença MIT. Consulte `LICENSE` para mais detalhes.
