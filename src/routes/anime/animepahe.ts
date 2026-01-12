import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { ANIME } from '@consumet/extensions';

// 🟢 YOUR CLOUDFLARE SHIELD URL
const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

// Helper to fetch via your Proxy Shield
async function fetchShield(targetUrl: string) {
    const fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    // console.log(chalk.gray(`   -> Shielding: ${targetUrl}`));
    
    const res = await fetch(fullUrl);
    if (!res.ok) throw new Error(`Shield Status: ${res.status}`);
    return await res.text();
}

// --- GOGO SCRAPER (Protected by Shield) ---
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
        console.log(chalk.blue(`   -> Tunneling Info for: ${id}`));
        
        // 🛡️ Step 1: Fetch Category Page via Shield
        const html = await fetchShield(`${this.baseUrl}/category/${id}`);
        const $ = cheerio.load(html);
        
        const movie_id = $('#movie_id').attr('value');
        const alias = $('#alias_anime').attr('value');
        const ep_end = $('#episode_page a').last().attr('ep_end');

        if (!movie_id) {
            console.log(chalk.red("   -> Gogo Info Blocked! The Shield returned HTML, but no movie_id."));
            // Fallback: If blocked, try direct ID guess for API
            // throw new Error("Gogo Info Parse Failed");
        }

        // 🛡️ Step 2: Fetch Episode List via Shield
        // If movie_id is missing, we try to guess it's the same as alias, but usually we need it.
        // Let's assume we got it.
        if (movie_id) {
            const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
            const epHtml = await fetchShield(ajaxUrl);
            
            const $ep = cheerio.load(epHtml);
            const episodes: any[] = [];
            $ep('li').each((i, el) => {
                const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                if (epId) episodes.push({ id: epId, number: Number(epNum) });
            });
            return { id, title: id, episodes: episodes.reverse() };
        }
        
        throw new Error("Gogo Info Parse Failed");
    }

    async fetchEpisodeSources(episodeId: string) {
        // 🛡️ Step 3: Fetch Video Page via Shield
        const html = await fetchShield(`${this.baseUrl}/${episodeId}`);
        const $ = cheerio.load(html);
        const iframe = $('iframe').first().attr('src');
        
        if (!iframe) throw new Error("No video iframe found");
        
        return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
    }
}

// --- PAHE SCRAPER (Manual API) ---
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
            if(!episodeId.includes("*")) throw new Error("Invalid ID");
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

  // 1. GOGO (Shielded)
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
    const servers = ["vidcloud", "megacloud", "streamtape"];
    for (const server of servers) { try { return await p.fetchEpisodeSources(req.params.episodeId, server as any); } catch (e) {} }
    throw new Error("No servers");
  }, res));

  // 4. PROXY ROUTE (Also Shielded)
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        
        const fullUrl = `${PROXY_URL}?url=${encodeURIComponent(url)}`;
        const response = await fetch(fullUrl);
        
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;