import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// --- PROXY HELPER ---
async function fetchWithProxy(url: string, referer: string) {
    try {
        // 1. Try Direct
        let res = await fetch(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36', 
                'Referer': referer 
            } 
        });
        if(res.ok) {
            const text = await res.text();
            if(!text.includes("Just a moment") && !text.includes("Verify you are human")) return text;
        }
        
        // 2. Fallback: Google Translate Proxy (Bypass Cloudflare)
        console.log(chalk.yellow("   -> Direct failed. Engaging Google Proxy..."));
        const proxyUrl = `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(url)}`;
        res = await fetch(proxyUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        return await res.text();
    } catch(e) { return ""; }
}

// --- CUSTOM GOGO ---
class CustomGogo {
    baseUrl = "https://gogoanime3.co";

    async search(query: string) {
        // Blind Trust: Always return a result
        const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return { 
            results: [{ 
                id: guessId, 
                title: query, 
                image: "https://gogocdn.net/cover/naruto-shippuden.png", 
                releaseDate: "Force Match" 
            }] 
        };
    }

    async fetchAnimeInfo(id: string) {
        const text = await fetchWithProxy(`${this.baseUrl}/category/${id}`, this.baseUrl);
        
        const idMatch = text.match(/value="([^"]+)"\s*id="movie_id"/);
        const aliasMatch = text.match(/value="([^"]+)"\s*id="alias_anime"/);
        const epMatch = text.match(/ep_end\s*=\s*['"](\d+)['"]/);

        if (!idMatch) throw new Error("Gogo Blocked (Proxy Failed)");

        const movie_id = idMatch[1];
        const alias = aliasMatch ? aliasMatch[1] : id;
        const ep_end = epMatch ? epMatch[1] : "1000";

        // Fetch Episodes from AJAX
        const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
        const epRes = await fetch(ajaxUrl);
        const epHtml = await epRes.text();
        
        const $ = cheerio.load(epHtml);
        const episodes: any[] = [];
        $('li').each((i, el) => {
            const epId = $(el).find('a').attr('href')?.trim().replace('/', '');
            const epNum = $(el).find('.name').text().replace('EP ', '').trim();
            if (epId) episodes.push({ id: epId, number: Number(epNum) });
        });

        return { id, title: id, episodes: episodes.reverse() };
    }

    async fetchEpisodeSources(episodeId: string) {
        const text = await fetchWithProxy(`${this.baseUrl}/${episodeId}`, this.baseUrl);
        const $ = cheerio.load(text);
        const iframe = $('iframe').first().attr('src');
        if (!iframe) throw new Error("Gogo Video Blocked");
        return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
    }
}

// --- CUSTOM PAHE ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";
    headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

    async search(query: string) {
        try {
            const res = await fetch(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`, { headers: this.headers });
            const data: any = await res.json();
            return { results: (data.data || []).map((i:any) => ({ id: i.session, title: i.title, image: i.poster })) };
        } catch (e) { return { results: [] }; }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const res = await fetch(`${this.baseUrl}/api?m=release&id=${id}&sort=episode_asc&page=1`, { headers: this.headers });
            const data: any = await res.json();
            const episodes = (data.data || []).map((ep:any) => ({ id: `${id}*${ep.session}`, number: ep.episode }));
            return { id, title: "AnimePahe", episodes };
        } catch (e) { throw new Error("Pahe Info Error"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            if(!episodeId.includes("*")) throw new Error("Invalid ID format");
            const [animeId, epId] = episodeId.split("*");
            
            const res = await fetch(`${this.baseUrl}/play/${animeId}/${epId}`, { headers: this.headers });
            const html = await res.text();
            
            const kwikMatch = html.match(/https:\/\/kwik\.cx\/e\/[a-zA-Z0-9]+/);
            if(!kwikMatch) throw new Error("Kwik link missing");
            
            return { sources: [{ url: kwikMatch[0], quality: '720p', isM3U8: false }] };
        } catch (e: any) { throw new Error("Pahe Watch Error: " + e.message); }
    }
}

const customGogo = new CustomGogo();
const customPahe = new CustomPahe();

const routes = async (fastify: FastifyInstance, options: any) => {
  const safeRun = async (providerName: string, fn: () => Promise<any>, reply: any) => {
    try {
        console.log(chalk.blue(`[${providerName}] Running...`));
        const res = await fn();
        console.log(chalk.green(`   -> Success`));
        return reply.send(res);
    } catch (e: any) {
        console.error(chalk.red(`   -> Error:`), e.message);
        return reply.status(200).send({ error: e.message, results: [] });
    }
  };

  // 1. GOGO
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // 2. PAHE
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => customPahe.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', () => {
      let id = req.params.episodeId.includes("~") ? req.params.episodeId.replace(/~/g,"*") : req.params.episodeId;
      return customPahe.fetchEpisodeSources(id);
  }, res));

  // 3. HIANIME (Standard)
  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', async () => {
    const p = new ANIME.Hianime();
    const servers = ["vidcloud", "megacloud", "vidstreaming", "streamtape"];
    for (const server of servers) { try { return await p.fetchEpisodeSources(req.params.episodeId, server as any); } catch (e) {} }
    throw new Error("No servers");
  }, res));

  // 4. KAI (Backup)
  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchEpisodeSources(req.params.episodeId), res));

  // PROXY
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        let referer = "https://gogoanime3.co/";
        if (url.includes("kwik")) referer = "https://kwik.cx/";
        const response = await fetch(url, { headers: { 'Referer': referer, 'User-Agent': "Mozilla/5.0" } });
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;